import type { Logger } from '@apollo/utils.logger';
import type { GraphQLSchema } from 'graphql';
import type {
  GatewayExecutor,
  GatewayInterface,
  GatewayUnsubscriber,
} from '@apollo/server-gateway-interface';
import type { SchemaDerivedData } from '../ApolloServer.js';
import type {
  ApolloConfig,
  GraphQLSchemaContext,
} from '../externalTypes/index.js';

import * as pg from 'pg';

import { Neo4jGraphQL } from '@neo4j/graphql';
import type { Driver } from 'neo4j-driver';
import { Kafka } from 'kafkajs';
import type { ApolloServerOptionsForKafkaListener } from '../externalTypes/constructor.js';

type SchemaDerivedDataProvider = (
  apiSchema: GraphQLSchema,
) => SchemaDerivedData;

type SchemaMap = {
  [tenantName: string] : SchemaDerivedData;
};

/**
 * An async-safe class for tracking changes in schemas and schema-derived data.
 *
 * Specifically, as long as start() is called (and completes) before stop() is
 * called, any set of executions of public methods is linearizable.
 *
 * Note that linearizability in Javascript is trivial if all public methods are
 * non-async, but increasingly difficult to guarantee if public methods become
 * async. Accordingly, if you believe a public method should be async, think
 * carefully on whether it's worth the mental overhead. (E.g. if you wished that
 * a callback was async, consider instead resolving a Promise in a non-async
 * callback and having your async code wait on the Promise in setTimeout().)
 */
export class SchemaManager {
  private readonly logger: Logger;
  private readonly schemaDerivedDataProvider: SchemaDerivedDataProvider;
  private readonly onSchemaLoadOrUpdateListeners = new Set<
    (schemaContext: GraphQLSchemaContext) => void
  >();
  private isStopped = false;
  private schemaDerivedData?: SchemaDerivedData;
  private schemaContext?: GraphQLSchemaContext;
  private neo4jDriver?:Driver;
  private kafkaProperties?:ApolloServerOptionsForKafkaListener;

  private schemaMap:SchemaMap = {};

  private pgclient:pg.Client;

  // For state that's specific to the mode of operation.
  private readonly modeSpecificState:
    | {
        readonly mode: 'gateway';
        readonly gateway: GatewayInterface;
        readonly apolloConfig: ApolloConfig;
        unsubscribeFromGateway?: GatewayUnsubscriber;
      }
    | {
        readonly mode: 'schema';
        readonly apiSchema: GraphQLSchema;
        readonly schemaDerivedData: SchemaDerivedData;
      };

  constructor(
    options: (
      | { gateway: GatewayInterface; apolloConfig: ApolloConfig }
      | { apiSchema: GraphQLSchema; neo4jDriver?: Driver; kafkaProperties?: ApolloServerOptionsForKafkaListener }
    ) & {
      logger: Logger;
      schemaDerivedDataProvider: SchemaDerivedDataProvider;
    },
  ) {
    this.logger = options.logger;
    this.schemaDerivedDataProvider = options.schemaDerivedDataProvider;
    this.schemaMap = {};
    this.pgclient = new pg.Client("postgres://postgres:postgres@10.11.10.128:5432/__multitenantdb");
    this.pgclient.connect();
    if ('gateway' in options) {
      this.modeSpecificState = {
        mode: 'gateway',
        gateway: options.gateway,
        apolloConfig: options.apolloConfig,
      };
    } else {
      this.neo4jDriver = options.neo4jDriver;
      this.kafkaProperties = options.kafkaProperties;
      this.modeSpecificState = {
        mode: 'schema',
        apiSchema: options.apiSchema,
        // The caller of the constructor expects us to fail early if the schema
        // given is invalid/has errors, so we call the provider here. We also
        // pass the result to start(), as the provider can be expensive to call.
        schemaDerivedData: options.schemaDerivedDataProvider(options.apiSchema),
      };
    }
  }

  /**
   * Calling start() will:
   * - Start gateway schema fetching (if a gateway was provided).
   * - Initialize schema-derived data.
   * - Synchronously notify onSchemaLoadOrUpdate() listeners of schema load, and
   *   asynchronously notify them of schema updates.
   * - If we started a gateway, returns the gateway's executor; otherwise null.
   */
  public async start(): Promise<GatewayExecutor | null> {
    if (this.modeSpecificState.mode === 'gateway') {
      const gateway = this.modeSpecificState.gateway;
      if (gateway.onSchemaLoadOrUpdate) {
        // Use onSchemaLoadOrUpdate, as it reports the core supergraph SDL and
        // always reports the initial schema load.
        this.modeSpecificState.unsubscribeFromGateway =
          gateway.onSchemaLoadOrUpdate((schemaContext) => {
            this.processSchemaLoadOrUpdateEvent(schemaContext);
          });
      } else {
        throw new Error(
          "Unexpectedly couldn't find onSchemaLoadOrUpdate on gateway",
        );
      }

      const config = await this.modeSpecificState.gateway.load({
        apollo: this.modeSpecificState.apolloConfig,
      });

      return config.executor;
    } else {
      this.processSchemaLoadOrUpdateEvent(
        {
          apiSchema: this.modeSpecificState.apiSchema,
        },
        this.modeSpecificState.schemaDerivedData,
      );
      if(this.neo4jDriver && this.kafkaProperties){
        let kafka = new Kafka({brokers:['localhost:9092']});
        let consumer = kafka.consumer({groupId:'21323'});
        await consumer.connect();
        await consumer.subscribe({ topic: 'graphqlschemas', fromBeginning: true });
        await consumer.run({
          eachMessage: async ({ topic, partition, message }) => {
            console.log({
              partition,
              offset: message.offset,
              value: message.value?.toString(),
              topic:topic
            });
            if(message.value){
              console.log("updating tenant in cache... : ", message.value.toString());
              let query = await this.pgclient.query("select * from graphschemas where tenant_name='"+message.value.toString()+"'");
              let typeDefs = '';
              if(query.rowCount>0){
                for(var i=0;i<query.rowCount;i++){
                  typeDefs = typeDefs + '\n' + query.rows[i]['schema_text'];
                }
                let graphsch = await new Neo4jGraphQL({typeDefs:typeDefs, driver: this.neo4jDriver, config:{driverConfig:{database:message.value.toString()}}}).getSchema();
                this.schemaMap[message.value.toString()]=this.schemaDerivedDataProvider(graphsch);
                console.log("updated tenant in cache!!! : ", message.value.toString());
              }else{
                throw new Error('No schemas found for this tenant : ' + message.value.toString());
              }
            }
          },
        });
      }
      return null;
    }
  }

  /**
   * Registers a listener for schema load/update events. Note that the latest
   * event is buffered, i.e.
   * - If registered before start(), this method will throw. (We have no need
   *   for registration before start(), but this is easy enough to change.)
   * - If registered after start() but before stop(), the callback will be first
   *   called in this method (for whatever the current schema is), and then
   *   later for updates.
   * - If registered after stop(), the callback will never be called.
   *
   * For gateways, a core supergraph SDL will be provided to the callback.
   *
   * @param callback The listener to execute on schema load/updates.
   */
  public onSchemaLoadOrUpdate(
    callback: (schemaContext: GraphQLSchemaContext) => void,
  ): GatewayUnsubscriber {
    if (!this.schemaContext) {
      throw new Error('You must call start() before onSchemaLoadOrUpdate()');
    }
    if (!this.isStopped) {
      try {
        callback(this.schemaContext);
      } catch (e) {
        // Note that onSchemaLoadOrUpdate() is currently only called from
        // ApolloServer._start(), so we throw here to alert the user early
        // that their callback is failing.
        throw new Error(
          `An error was thrown from an 'onSchemaLoadOrUpdate' listener: ${
            (e as Error).message
          }`,
        );
      }
    }
    this.onSchemaLoadOrUpdateListeners.add(callback);

    return () => {
      this.onSchemaLoadOrUpdateListeners.delete(callback);
    };
  }

  public getDriver():Driver{
    if(!this.neo4jDriver){
      throw new Error('You must declare a driver!!!');
    }
    return this.neo4jDriver;
  }

  /**
   * Get the schema-derived state for the current schema. This throws if called
   * before start() is called.
   */
  public getSchemaDerivedData(): SchemaDerivedData {
    if (!this.schemaDerivedData) {
      throw new Error('You must call start() before getSchemaDerivedData()');
    }
    return this.schemaDerivedData;
  }

  public async getSchemaDerivedDataMultiTenant(tenant: string): Promise<SchemaDerivedData> {
    if (!this.schemaDerivedData) {
      throw new Error('You must call start() before getSchemaDerivedData()');
    }
    console.log("Schema derived data of tenant :", tenant);
    if(this.schemaMap[tenant]===undefined){
      console.log("tenant not present in cache : ", tenant);
      console.log("adding tenant in cache... : ", tenant);
      let query = await this.pgclient.query("select * from graphschemas where tenant_name='"+tenant+"'");
      let typeDefs = '';
      if(query.rowCount>0){
        for(var i=0;i<query.rowCount;i++){
          typeDefs = typeDefs + '\n' + query.rows[i]['schema_text'];
        }
        let graphsch = await new Neo4jGraphQL({typeDefs:typeDefs, driver: this.neo4jDriver, config:{driverConfig:{database:tenant}}}).getSchema();
        this.schemaMap[tenant]=this.schemaDerivedDataProvider(graphsch);
        console.log("added tenant in cache!!! : ", tenant);
      }else{
        throw new Error('No schemas found for this tenant : ' + tenant);
      }
    }
    return this.schemaMap[tenant];
  }

  /**
   * Calling stop() will:
   * - Stop gateway schema fetching (if a gateway was provided).
   *   - Note that this specific step may not succeed if gateway is old.
   * - Stop updating schema-derived data.
   * - Stop notifying onSchemaLoadOrUpdate() listeners.
   */
  public async stop(): Promise<void> {
    this.isStopped = true;
    if (this.modeSpecificState.mode === 'gateway') {
      this.modeSpecificState.unsubscribeFromGateway?.();
      await this.modeSpecificState.gateway.stop?.();
    }
  }

  private processSchemaLoadOrUpdateEvent(
    schemaContext: GraphQLSchemaContext,
    schemaDerivedData?: SchemaDerivedData,
  ): void {
    if (!this.isStopped) {
      this.schemaDerivedData =
        schemaDerivedData ??
        this.schemaDerivedDataProvider(schemaContext.apiSchema);
      this.schemaContext = schemaContext;
      this.onSchemaLoadOrUpdateListeners.forEach((listener) => {
        try {
          listener(schemaContext);
        } catch (e) {
          this.logger.error(
            "An error was thrown from an 'onSchemaLoadOrUpdate' listener",
          );
          this.logger.error(e);
        }
      });
    }
  }
}
