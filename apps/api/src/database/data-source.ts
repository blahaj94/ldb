import { createDatabaseDataSource, readDatabaseConfiguration } from './index.js'

const dataSource = createDatabaseDataSource(readDatabaseConfiguration(process.env))

export default dataSource
