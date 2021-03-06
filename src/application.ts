import {BootMixin} from '@loopback/boot';
import {ApplicationConfig} from '@loopback/core';
import {
  RestExplorerBindings,
  RestExplorerComponent,
} from '@loopback/rest-explorer';
import {RepositoryMixin, AnyObject} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {ServiceMixin} from '@loopback/service-proxy';
import * as path from 'path';
import {MySequence} from './sequence';
import {string as strValidator} from '@hapi/joi';
import * as _ from 'lodash';
import {OpenApiService, GraphQLService} from './services';
import * as fs from 'fs';
import * as yargs from 'yargs';

export class GqlApplication extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  private argv: any = null;
  private openApi: OpenApiService;
  private graphQL: GraphQLService;

  constructor(options: ApplicationConfig = {}) {
    super(options);

    // Parse args and load OAS

    this.run();

    // Set up the custom sequence
    this.sequence(MySequence);

    // Set up default home page
    this.static('/', path.join(__dirname, '../public'));

    // Customize @loopback/rest-explorer configuration here
    if (process.env['ICGQL_ENV'] === 'dev') {
      this.bind(RestExplorerBindings.CONFIG).to({
        path: '/explorer',
        useSelfHostedSpec: false,
      });
      this.component(RestExplorerComponent);
    }

    this.projectRoot = __dirname;
    // Customize @loopback/boot Booter Conventions here
    this.bootOptions = {
      controllers: {
        // Customize ControllerBooter Conventions here
        dirs: ['controllers'],
        extensions: ['.controller.js'],
        nested: true,
      },
    };
  }

  private run() {
    this.init()
      .then(() => {})
      .catch(() => {});
  }

  async init() {
    this.parseArgs();
    this.setDefaultArgs();
    this.openApi = new OpenApiService();
    this.graphQL = new GraphQLService(this.getSync('opsMap'));
    if (this.argv.validate) {
      await this.openApi.validate(this.argv.oas);
    }
  }

  async loadOAS() {
    let oasData: string[] = [];
    let openAPISchema: AnyObject[] = [];

    oasData = await this.openApi.load(this.argv.oas);
    openAPISchema = await this.openApi.parse(oasData);

    if (this.argv.param) {
      this.openApi.addParameters(openAPISchema, this.argv.param);
    }

    const ops: AnyObject[] = this.getSync('opsMap');

    const {
      schema: graphQLSchema,
      report: graphQLReport,
    } = await this.graphQL.createSchema(this.argv, openAPISchema as any, ops);

    if (this.argv.report) {
      console.log('Stats:\n\n');
      console.log(_.omit(graphQLReport, 'warnings'));
      if (graphQLReport.warnings) {
        console.log('There are warnings:\n');
        for (const warn of graphQLReport.warnings) {
          console.log(`
          Message: ${warn.message}
          Mitigation: ${warn.mitigation}
          `);
        }
      }
    }

    this.bind('oasSchema').to(openAPISchema);
    this.bind('gqlSchema').to(graphQLSchema);
    this.bind('gqlReport').to(graphQLReport);
  }

  setDefaultArgs() {
    const toOpArray = function(type: string) {
      return function(value: any) {
        const data = value.split(':');
        return {type, method: data[0], path: data[1]};
      };
    };

    const toObject = (arg: any) => {
      const ret: {[key: string]: any} = {};
      for (const item of arg) {
        const pair = item.split(':');
        ret[pair[0]] = pair[1];
      }
      return ret;
    };

    this.restServer.config.port = this.argv.port;
    this.restServer.config.host = this.argv.host;

    if (!this.argv.oas) {
      const protocol = this.argv.key ? 'https' : 'http';
      this.argv.oas = [
        `${protocol}://${this.argv.host}:${this.argv.port}/api/openapi.json`,
      ];
    }

    if (this.argv.header) {
      this.argv.headerObj = toObject(this.argv.header);
    }

    if (this.argv.queryStr) {
      this.argv.queryObj = toObject(this.argv.queryStr);
    }

    let ops: any = [];

    if (this.argv.query) {
      ops = [...this.argv.query.map(toOpArray('query'))];
    }

    if (this.argv.mutation) {
      ops = [...ops, ...this.argv.mutation.map(toOpArray('mutation'))];
    }

    this.bind('opsMap').to(ops);
    this.bind('serverKey').to(
      this.argv.key ? fs.readFileSync(this.argv.key).toString() : null,
    );
    this.bind('serverCert').to(
      this.argv.cert ? fs.readFileSync(this.argv.cert).toString() : null,
    );

    return this;
  }

  parseArgs(): GqlApplication {
    const uriSchema = strValidator().uri({scheme: ['http', 'https']});

    const toArray = function(arg: any) {
      return Array.isArray(arg) ? arg : [arg];
    };
    const kvPairTest = (v: any) => /^[a-z0-9_\-]+:[a-z0-9_\-\/]+$/i.test(v);
    const kvTrippleTest = (v: any) =>
      /^(header|query|path|cookie):[a-z0-9_\-\/]+:[a-z0-9_\-\/]+$/i.test(v);
    const urlOrFileTest = (v: any) => {
      const isURL = Boolean(!uriSchema.validate(v).error);
      return isURL || fs.existsSync(v);
    };
    this.argv = yargs
      .option('baseUrl', {
        type: 'string',
        describe: 'The base url',
      })
      .option('oas', {
        type: 'string',
        describe:
          'Path or URL of an OAS 2 / 3 YAML or JSON spec. You may supply this flag multiple times.',
      })
      .option('key', {
        type: 'string',
        describe: 'Path to key file. Used by the HTTPS server.',
      })
      .option('cert', {
        type: 'string',
        describe: 'Path to key file. Used by the HTTPS server.',
      })
      .option('host', {
        type: 'string',
        default: '127.0.0.1',
        describe:
          'The host address of the server. Should be a fully qualified domain or IP.',
      })
      .option('port', {
        type: 'number',
        default: 3000,
        describe: 'The port number the server should be listening at.',
      })
      .option('limit', {
        type: 'boolean',
        default: true,
        describe: 'Wether or not to add limit to lists',
      })
      .option('fill', {
        type: 'boolean',
        default: true,
        describe: 'Wether or not to fill empty responses',
      })
      .option('strict', {
        type: 'boolean',
        default: false,
        describe: 'Wether or not to run in strict mode',
      })
      .option('errors', {
        type: 'boolean',
        default: true,
        describe:
          'Wether or not print debug info and extra verbose op descriptions.',
      })
      .option('header', {
        type: 'string',
        describe:
          'A custom HTTP header to be passed to each request generated by GQL. Format: headerName:value. You may supply this flag multiple times.',
      })
      .option('queryStr', {
        type: 'string',
        describe:
          'A custom HTTP query string parameter to be passed to each request generated by GQL. Format: name:value. You may supply this flag multiple times',
      })
      .option('query', {
        type: 'string',
        describe:
          'Treat this op as query. Argument is the HTTP method - path separated by colon. You may supply this flag multiple times.',
      })
      .option('mutation', {
        type: 'string',
        describe:
          'Treat this op as mutation. Argument is the HTTP method - path separated by colon. You may supply this flag multiple times.',
      })
      .option('report', {
        type: 'boolean',
        default: false,
        describe: 'Print report after generating GraphQL schema.',
      })
      .option('validate', {
        type: 'boolean',
        default: false,
        describe:
          'Strict OAS validation. If false, only JSON / YAML conformity will be checked.',
      })
      .option('param', {
        type: 'string',
        describe:
          'A custom parameter to be added to each OAS operation. Format: type:schema:name. A required param will be added to the OAS parameters object. Values must specified by the user, at runtime. You may supply this flag multiple times.',
      })
      .implies('key', 'cert')
      .implies('cert', 'key')
      .normalize('key')
      .normalize('cert')
      .coerce('header', toArray)
      .coerce('queryStr', toArray)
      .coerce('query', toArray)
      .coerce('mutation', toArray)
      .coerce('oas', toArray)
      .coerce('param', toArray)
      .group(['host', 'port', 'key', 'cert'], 'Server options:')
      .group(['oas'], 'OpenAPI options:')
      .group(['validate'], 'Validation options:')
      .group(['limit', 'fill', 'strict', 'baseUrl'], 'GraphQL options:')
      .group(['queryStr', 'header'], 'Options for generated requests:')
      .group(['query', 'mutation'], 'Transformation options:')
      .group(['report', 'errors'], 'Debug and reporting options:')
      .check((argv: any) => {
        setTimeout(() => {
          if (!argv.oas.every(urlOrFileTest)) {
            throw new Error(
              `OAS is not URL or existing path: "${argv.oas.join(',')}"`,
            );
          } else if (argv.key && !fs.existsSync(argv.key)) {
            throw new Error(`The key file doesn't exist: "${argv.key}"`);
          } else if (argv.cert && !fs.existsSync(argv.cert)) {
            throw new Error(
              `The certificate file doesn't exist: "${argv.cert}"`,
            );
          } else if (argv.baseUrl && uriSchema.validate(argv.baseUrl).error) {
            throw new Error(`The base URL is invalid: "${argv.baseUrl}"`);
          } else if (argv.header && !argv.header.every(kvPairTest)) {
            throw new Error(
              `One or more header is not fromatted  correctly: "${argv.header.join(
                ',',
              )}"`,
            );
          } else if (argv.queryStr && !argv.queryStr.every(kvPairTest)) {
            throw new Error(
              `One or more query param is not fromatted  correctly: "${argv.queryStr.join(
                ',',
              )}"`,
            );
          } else if (argv.query && !argv.query.every(kvPairTest)) {
            throw new Error(
              `One or more query mappings are not fromatted correctly: "${argv.query.join(
                ',',
              )}"`,
            );
          } else if (argv.mutation && !argv.mutation.every(kvPairTest)) {
            throw new Error(
              `One or more mutation mappings are not fromatted correctly: "${argv.mutation.join(
                ',',
              )}"`,
            );
          } else if (argv.param && !argv.param.every(kvTrippleTest)) {
            throw new Error(
              `One or more OAS params are not fromatted correctly: "${argv.param.join(
                ',',
              )}"`,
            );
          }
        });
        return true;
      }, true)
      .locale('pirate')
      .env('ICGQL')
      .completion('autocomplete')
      .usage('npm start -- [options]')
      .example(
        'npm start -- --baseUrl http://127.0.0.1:3000/api',
        'Node server mode',
      )
      .example(
        'npm start -- --oas http://some.domain.com:10001/openapi  --header Content-Type:application/json',
        'GraphQL layer covering a single REST API',
      )
      .example(
        'npm start -- --oas http://some.domain.com:10001/openapi -o http://some.domain.com:10008/openapi -baseUrl http://some.domain.com --header sessionToken:someToken --header login:someUser --header Content-Type:application/json',
        'GraphQL layer covering multiple REST APIs and auth',
      )
      .showHelpOnFail(true)
      .wrap(yargs.terminalWidth())
      .epilogue(
        `Copyright by i-Cell Mobilsoft ${new Date().getFullYear()}. All rights reserved. See http://github.com/icellmobilsoft/graphqlserver`,
      )
      .help().argv;

    return this;
  }
}
