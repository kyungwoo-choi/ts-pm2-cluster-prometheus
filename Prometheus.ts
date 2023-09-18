import {
  AggregatorRegistry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Metric, MetricObject, MetricObjectWithValues, MetricValue,
  Registry,
  Summary
} from "prom-client";
import pm2 from "pm2";
import {NextFunction, Request, response, Response} from 'express'
import responseTime from 'response-time'
import {type} from "os";

interface IRegisterMetricParams {
  type: 'counter' | 'gauge' | 'histogram' | 'summary'
  name: string
  help: string
  labelNames: string[]
  buckets?: any[]
}

interface IMetricInstance {
  type: string
  instance: Counter | Gauge | Histogram | Summary
}

interface IPrometheusInitParams {
  withRPSMetric: boolean
}

export default class Prometheus {
  private readonly registry: Registry
  private readonly instances: { [index: string]: IMetricInstance }
  private readonly pm_id: number
  private readonly withRPSMetric: boolean = false

  constructor({withRPSMetric = false}: IPrometheusInitParams) {
    this.registry = new Registry()
    this.instances = {}
    this.pm_id = process.env.pm_id && +process.env.pm_id > -1 ? +process.env.pm_id : 0

    collectDefaultMetrics({
      register: this.registry,
      // prefix: 'godo_node_',
      labels: {NODE_APP_INSTANCE: 'user-event-producer'}
    });

    if (withRPSMetric) {
      this.createRPSMetric()
      this.withRPSMetric = withRPSMetric
    }
  }

  public getContentType = (): string => this.registry.contentType
  public getInstance = (name: string): IMetricInstance => this.instances[name]
  public getMetricAsJson = () => this.registry.getMetricsAsJSON()

  public aggregate = (metrics: Metric[] | MetricObject[] | MetricObjectWithValues<MetricValue<string>>[][]): Registry => AggregatorRegistry.aggregate(Object.values(metrics).map(o => o))

  public registerMetric({type, name, help, labelNames, buckets}: IRegisterMetricParams): void {
    let instance: Counter | Gauge | Histogram | Summary | null = null

    if (type === 'counter') instance = new Counter({name, help, labelNames})
    else if (type === 'gauge') instance = new Gauge({name, help, labelNames})
    else if (type === 'histogram') instance = new Histogram({name, help, labelNames})
    else if (type === 'summary') instance = new Summary({name, help})

    if (!instance) return

    this.registry.registerMetric(instance)
    this.instances[name] = {type, instance}
  }

  // send message to all instances to collect metrics
  public collectMetrics(): Promise<Metric[]> {
    return new Promise((resolve, reject) => {
      pm2.describe('event-producer', (error, processList) => {
        if (error) return reject()

        const processPmIds = processList.map((e) => e.pm_id || 0)

        // broadcast all instances
        processPmIds.forEach(pmId => {
          pm2.sendDataToProcessId(
            pmId,
            {id: pmId, topic: 'get_metrics', data: {}, from: this.pm_id},
            () => {
            })
        })

        const metrics: Metric[] = []
        const returnMetricsHandler = async (packet: any) => {
          if (packet && packet.topic === 'return_metrics') {
            metrics.push(packet.data)

            if (metrics.length === processPmIds.length) {
              process.removeListener('message', returnMetricsHandler)
              resolve(metrics)
            }
          }
        }
        process.removeListener('message', returnMetricsHandler)
        process.on('message', returnMetricsHandler)
      })
    })
  }

  // send metrics to parent process using pm_id of packet
  public async sendMetrics(targetPmId: number) {
    const metrics = await this.registry.getMetricsAsJSON()
    pm2.sendDataToProcessId(
      targetPmId,
      {topic: 'return_metrics', data: metrics, from: this.pm_id},
      () => {
      }
    )
  }

  // register handler for receive messages from parent process
  public async processMessageHandler() {
    if (!process.env.exec_mode || process.env.exec_mode !== 'cluster') return
    const handler = async (packet: any) => {
      if (packet && packet.from > -1 && packet.topic === 'get_metrics') this.sendMetrics(packet.from)
    }

    process.removeListener('message', handler)
    process.on('message', handler)
  }

  public metricsRouter = async (request: Request, response: Response) => {
    let metrics
    if (!process.env.exec_mode || process.env.exec_mode !== 'cluster') metrics = [await this.registry.getMetricsAsJSON()]
    else metrics = await this.collectMetrics()

    const aggregatedMetrics = await this.aggregate(metrics).metrics()
    response.setHeader('Content-Type', this.getContentType())
    response.send(aggregatedMetrics)
  }

  public rpsMiddleware = () => {
    return responseTime((request, response, time) => {
      if (request?.url) {
        try {
          const {instance: instance1} = this.instances['http_request_duration_ms']
          if (instance1 instanceof Histogram || instance1 instanceof Summary) {
            instance1.observe({
              method: request.method,
              route: request.url,
              status_code: response.statusCode,
            }, time);
          }

          const {instance: instance2} = this.getInstance('http_request_counter')
          if (instance2 instanceof Counter || instance2 instanceof Gauge) {
            instance2.inc({
              method: request.method,
              route: request.url,
              status_code: response.statusCode,
            }, 1);
          }
        } catch (e) {
          console.error(e);
        }
      }
    })
  }

  public createRPSMetric() {
    this.registerMetric({
      type: 'histogram',
      name: 'http_request_duration_ms',
      help: 'Duration of HTTP requests in ms',
      labelNames: ['method', 'route', 'status_code'],
      // buckets for response time from 0.1ms to 1s
      buckets: [0.1, 5, 15, 50, 100, 200, 300, 400, 500, 1000],
    })

    this.registerMetric({
      type: 'gauge',
      name: 'http_request_counter',
      help: 'Count of HTTP requests in ms',
      labelNames: ['method', 'route', 'status_code'],
    })
  }
}
