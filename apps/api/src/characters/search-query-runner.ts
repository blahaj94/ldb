import { Client } from 'pg'
import type { ClientConfig } from 'pg'
import type { DataSource, QueryRunner } from 'typeorm'
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver.js'
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner.js'
import { neopleSearchFailure } from '../errors/neople-search.js'

/** Pool acquire waiter를 만들지 않고 한 검색의 연결과 transaction을 함께 소유한다. */
class SearchQueryRunner extends PostgresQueryRunner {
  private readonly client: Client
  private connecting?: Promise<Client>
  private ending?: Promise<void>
  private rejectConnecting?: (error: Error) => void

  constructor(driver: PostgresDriver, private readonly signal: AbortSignal) {
    super(driver, 'master')
    const options = driver.options
    this.client = new Client({
      host: options.host,
      port: options.port,
      user: options.username,
      password: options.password,
      database: options.database,
      connectionString: options.url,
      // TypeORM 1.1.1은 server용 TlsOptions로 선언하지만 실제 pg 경계는 tls.connect 옵션이다.
      ssl: options.ssl as ClientConfig['ssl'],
      // pg 8.23 non-pipeline의 end()는 진행 중 query의 socket을 실제로 종료한다.
      pipeline: false,
    })
    this.manager = driver.dataSource.createEntityManager(this)
    // Idle connection 오류도 원문을 log하거나 unhandled EventEmitter 오류로 노출하지 않는다.
    this.client.on('error', this.stop)
    signal.addEventListener('abort', this.stop, { once: true })
    if (signal.aborted) this.stop()
  }

  private readonly stop = (): void => {
    this.isReleased = true
    this.signal.removeEventListener('abort', this.stop)
    this.rejectConnecting?.(neopleSearchFailure('internal'))
    this.rejectConnecting = undefined
    this.ending ??= this.client.end()
    // 응답 deadline과 연결 종료 완료는 별개다. release()가 같은 종료 결과를 기다린다.
    void this.ending.catch(() => undefined)
  }

  override connect(): Promise<Client> {
    if (this.isReleased) return Promise.reject(neopleSearchFailure('internal'))
    this.connecting ??= new Promise<Client>((resolve, reject) => {
      // pg는 connecting 중 client.end()로 종료하면 connect callback을 부르지 않을 수 있다.
      this.rejectConnecting = reject
      this.client.connect((error?: Error) => {
        this.rejectConnecting = undefined
        const hasError = error != null
        const cannotUseConnection = hasError || this.isReleased
        if (cannotUseConnection) reject(neopleSearchFailure('internal'))
        else resolve(this.client)
      })
    })
    return this.connecting
  }

  override async release(): Promise<void> {
    this.stop()
    try {
      await this.ending
    } finally {
      this.client.removeListener('error', this.stop)
    }
  }
}

export function createSearchQueryRunner(source: DataSource, signal: AbortSignal): QueryRunner {
  const driver = source.driver
  const isPostgres = driver instanceof PostgresDriver
  if (!isPostgres) throw neopleSearchFailure('internal')
  return new SearchQueryRunner(driver, signal)
}
