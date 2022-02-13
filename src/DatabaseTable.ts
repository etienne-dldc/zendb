import DB from 'better-sqlite3';
import { PipeCollection, PipeParent, PipeSingle } from './Pipe';
import { PreparedQuery } from './PreparedQuery';
import { notNil, PRIV, traverserFromRowIterator } from './Utils';
import { SchemaAny } from './Schema';
import { sql, Table, ValuesAny, ValuesParsed } from './sql';
import { SchemaIndexesAny, SchemaTableInternalAny } from './SchemaTable';

type QueriesCache = {
  insert: DB.Statement | null;
  deleteByKey: DB.Statement | null;
  updateByKey: DB.Statement | null;
  selectAll: DB.Statement | null;
  findByKey: DB.Statement | null;
  countAll: DB.Statement | null;
};

type IndexQueriesCache<IndexName extends string> = { [K in IndexName]?: DB.Statement | undefined };

export type DatabaseTableAny = DatabaseTable<
  string | number | symbol,
  any,
  any,
  SchemaIndexesAny<any>
>;

export class DatabaseTable<
  Name extends string | number | symbol,
  Key,
  Data,
  Indexes extends SchemaIndexesAny<Data>
> {
  readonly name: Name;
  readonly schema: SchemaAny;

  private readonly getDb: () => DB.Database;
  private readonly tableConfig: SchemaTableInternalAny;
  private readonly pipeParent: PipeParent<Key>;
  private readonly sqlTable: Table;

  private readonly cache: QueriesCache = {
    insert: null,
    deleteByKey: null,
    updateByKey: null,
    selectAll: null,
    findByKey: null,
    countAll: null,
  };
  private readonly indexQueriesCache: IndexQueriesCache<Indexes[number]['name']> = {};

  constructor(name: Name, schema: SchemaAny, getDb: () => DB.Database) {
    this.name = name;
    this.schema = schema;
    this.getDb = getDb;
    this.tableConfig = notNil(schema.tables[name as string])[PRIV];
    this.pipeParent = {
      deleteByKey: this.deleteByKey.bind(this),
      insert: this.insertInternal.bind(this),
      updateByKey: this.updateByKey.bind(this),
    };
    this.sqlTable = sql.Table.create(name as string);
  }

  private getStatement<Name extends keyof QueriesCache>(
    name: Name,
    create: () => QueriesCache[Name]
  ): NonNullable<QueriesCache[Name]> {
    if (this.cache[name] === null) {
      this.cache[name] = create();
    }
    return this.cache[name] as any;
  }

  private getIndexStatement<IndexName extends Indexes[number]['name']>(
    name: IndexName,
    create: () => DB.Statement
  ): DB.Statement {
    const current = this.indexQueriesCache[name];
    if (current === undefined) {
      const query = create();
      this.indexQueriesCache[name] = query;
      return query;
    }
    return current;
  }

  private getFindByIndexQuery<IndexName extends Indexes[number]['name']>(
    index: IndexName
  ): DB.Statement {
    return this.getIndexStatement(index, (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const data = this.sqlTable.column('data');
      const indexColumn = this.sqlTable.column(index);
      const query = sql.SelectStmt.print(
        sql.SelectStmt.create({
          columns: [key, data],
          from: this.sqlTable,
          where: sql.Expr.eq(indexColumn, sql.Param.createAnonymous()),
        })
      );
      return db.prepare(query);
    });
  }

  private getDeleteByKeyQuery(): DB.Statement {
    return this.getStatement('deleteByKey', (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const query = sql.DeleteStmt.print(
        sql.DeleteStmt.create({
          from: this.sqlTable,
          where: sql.Expr.eq(key, sql.Param.createAnonymous()),
        })
      );
      return db.prepare(query);
    });
  }

  private getUpdateByKeyQuery(): DB.Statement {
    return this.getStatement('updateByKey', (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const query = sql.UpdateStmt.print(
        sql.UpdateStmt.create({
          table: this.sqlTable,
          set: [
            [key, sql.Param.createAnonymous()],
            [this.sqlTable.column('data'), sql.Param.createAnonymous()],
            ...this.tableConfig.indexes.map(
              (index) => [this.sqlTable.column(index.name), sql.Param.createAnonymous()] as const
            ),
          ],
          where: sql.Expr.eq(key, sql.Param.createNamed('key')),
        })
      );
      return db.prepare(query);
    });
  }

  private getInsertQuery(): DB.Statement {
    return this.getStatement('insert', (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const data = this.sqlTable.column('data');
      const indexes = this.tableConfig.indexes.map((index) => this.sqlTable.column(index.name));
      const columns = [key, data, ...indexes] as const;
      const query = sql.InsertStmt.print(
        sql.InsertStmt.create({
          into: this.sqlTable,
          columns: [...columns],
          values: [columns.map(() => sql.Param.createAnonymous())],
        })
      );
      return db.prepare(query);
    });
  }

  private getSelectAllQuery(): DB.Statement {
    return this.getStatement('selectAll', (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const data = this.sqlTable.column('data');
      const query = sql.SelectStmt.print(
        sql.SelectStmt.create({
          columns: [key, data],
          from: this.sqlTable,
          orderBy: [key],
        })
      );
      return db.prepare(query);
    });
  }

  private getFindByKeyQuery(): DB.Statement {
    return this.getStatement('findByKey', (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const data = this.sqlTable.column('data');
      const query = sql.SelectStmt.print(
        sql.SelectStmt.create({
          columns: [key, data],
          from: this.sqlTable,
          where: sql.Expr.eq(key, sql.Param.createAnonymous()),
        }).limit(sql.Expr.literal(1))
      );
      return db.prepare(query);
    });
  }

  private getCountAllQuery(): DB.Statement {
    return this.getStatement('countAll', (): DB.Statement => {
      const db = this.getDb();
      const key = this.sqlTable.column('key');
      const query = sql.SelectStmt.print(
        sql.SelectStmt.create({
          columns: [sql.Aggregate.count(key).as('count')],
          from: this.sqlTable,
        })
      );
      return db.prepare(query);
    });
  }

  private prepareData(data: unknown): {
    key: Key;
    serailizedKey: any;
    data: string;
    indexes: Array<unknown>;
  } {
    const key = this.tableConfig.keyFn(data) as any;
    const serailizedKey = sql.Value.serialize(this.tableConfig.keyValue, key, 'key');
    const indexes = this.tableConfig.indexes.map((index) => {
      return sql.Value.serialize(index.value, index.fn(data), index.name);
    });
    const dataSer = JSON.stringify(this.schema.sanitize(data));
    return { key: key, serailizedKey, data: dataSer, indexes };
  }

  private deleteByKey(key: Key) {
    const serializedKey = sql.Value.serialize(this.tableConfig.keyValue, key, 'key');
    this.getDeleteByKeyQuery().run(serializedKey);
  }

  private insertInternal(data: unknown): { newKey: Key } {
    const params = this.prepareData(data);
    this.getInsertQuery().run(params.serailizedKey, params.data, ...params.indexes);
    return { newKey: params.key };
  }

  private updateByKey(key: Key, data: unknown): { updatedKey: Key } {
    const prepared = this.prepareData(data);
    const serializedKey = sql.Value.serialize(this.tableConfig.keyValue, key, 'key');
    const query = this.getUpdateByKeyQuery();
    const params: Array<any> = [
      prepared.serailizedKey,
      prepared.data,
      ...prepared.indexes,
      { key: serializedKey },
    ];
    query.run(...params);
    return { updatedKey: prepared.key };
  }

  private restore(data: string): Data {
    return this.schema.restore(JSON.parse(data)) as any;
  }

  insert(data: Data): PipeSingle<Key, Data, false> {
    const { newKey } = this.insertInternal(data);
    return new PipeSingle({ key: newKey, data }, this.pipeParent);
  }

  prepare(): PreparedQuery<Key, Data, Indexes, null>;
  prepare<Params extends ValuesAny>(params: Params): PreparedQuery<Key, Data, Indexes, Params>;
  prepare<Params extends ValuesAny>(
    params?: Params
  ): PreparedQuery<Key, Data, Indexes, Params | null> {
    return PreparedQuery.create({
      sqlTable: this.sqlTable,
      table: this.tableConfig,
      params: params ?? null,
      where: null,
      limit: null,
      orderBy: null,
    });
  }

  countAll(): number {
    const res = this.getCountAllQuery().get();
    return res.count;
  }

  count(query: PreparedQuery<Key, Data, Indexes, null>): number;
  count<Params extends ValuesAny>(
    query: PreparedQuery<Key, Data, Indexes, Params>,
    params: ValuesParsed<Params>
  ): number;
  count<Params extends ValuesAny | null>(
    query: PreparedQuery<Key, Data, Indexes, Params>,
    params?: Params extends ValuesAny ? ValuesParsed<Params> : null
  ): number {
    const db = this.getDb();
    const preparedQuery = query[PRIV].getCountQuery(db);
    const paramsValues = query[PRIV].params;
    const paramsSerialized =
      paramsValues === null ? {} : sql.Value.serializeValues(paramsValues, params as any);
    return preparedQuery.get(paramsSerialized as any).count;
  }

  select(query: PreparedQuery<Key, Data, Indexes, null>): PipeCollection<Key, Data>;
  select<Params extends ValuesAny>(
    query: PreparedQuery<Key, Data, Indexes, Params>,
    params: ValuesParsed<Params>
  ): PipeCollection<Key, Data>;
  select<Params extends ValuesAny | null>(
    query: PreparedQuery<Key, Data, Indexes, Params>,
    params?: Params extends ValuesAny ? ValuesParsed<Params> : null
  ): PipeCollection<Key, Data> {
    const db = this.getDb();
    const preparedQuery = query[PRIV].getSelectQuery(db);
    const paramsValues = query[PRIV].params;
    const paramsSerialized =
      paramsValues === null ? {} : sql.Value.serializeValues(paramsValues, params as any);
    const iter = preparedQuery.iterate(paramsSerialized as any);
    return new PipeCollection(
      traverserFromRowIterator<Key, string, Data>(iter, (data) => this.restore(data)),
      this.pipeParent
    );
  }

  findByIndex<IndexName extends Indexes[number]['name']>(
    index: IndexName,
    value: Extract<Indexes[number], { name: IndexName }>['_value']
  ): PipeCollection<Key, Data> {
    const indexConfig = notNil(this.tableConfig.indexes.find((i) => i.name === index));
    const preparedQuery = this.getFindByIndexQuery(index);
    const valueSerialized = sql.Value.serialize(indexConfig.value, value, indexConfig.name);
    const iter = preparedQuery.iterate(valueSerialized);
    return new PipeCollection(
      traverserFromRowIterator<Key, string, Data>(iter, (data) => this.restore(data)),
      this.pipeParent
    );
  }

  all(): PipeCollection<Key, Data> {
    const iter = this.getSelectAllQuery().iterate();
    return new PipeCollection(
      traverserFromRowIterator<Key, string, Data>(iter, (data) => this.restore(data)),
      this.pipeParent
    );
  }

  findByKey(key: Key): PipeSingle<Key, Data, true> {
    const query = this.getFindByKeyQuery();
    const serializedKey = sql.Value.serialize(this.tableConfig.keyValue, key, 'key');
    const entry = query.get(serializedKey);
    return new PipeSingle<Key, Data, true>(
      entry ? { key: entry.key as any, data: this.restore(entry.data as any) } : null,
      this.pipeParent
    );
  }
}
