import * as S3 from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Command as AWSCommand } from '@aws-sdk/smithy-client'
import * as AWSTypes from '@aws-sdk/types'
import colors from 'ansi-colors'
import { sizeFormatter } from 'human-readable'
import inquirer from 'inquirer'
import { accessSync, constants, createReadStream, createWriteStream, statSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { inspect } from 'node:util'
import { ArgumentsCamelCase, Argv } from 'yargs'
import { retrieveConfig, retrieveOnlyConfig } from './config'
import { ProgressBarCreator } from './main'

export { Command as AWSCommand } from '@aws-sdk/smithy-client'

function addAccountArg<T>(yargs: Argv<T>): Argv<T & { account?: string }> {
  return yargs.option('--account', {
    alias: 'a',
    description:
      'Specify the account to use if more than one is setup in the config. Can be the account ID or the name of the profile.',
    string: true,
  })
}

function addBucketArg<T>(yargs: Argv<T>): Argv<T & { bucket: string }> {
  return yargs.positional('bucket', { type: 'string', describe: 'The name of the bucket.', demandOption: true })
}

function addObjectArg<T>(yargs: Argv<T>): Argv<T & { object: string }> {
  return yargs.positional('object', { type: 'string', describe: 'The name of the object.', demandOption: true })
}

function addHelp(yargs: Argv): Argv {
  return yargs.option('h', { alias: 'help', description: 'Print more information about this command' })
}

function addSaveOption<T>(yargs: Argv<T>): Argv<T & { 'save-body-to'?: string }> {
  return yargs.option('save-body-to', {
    alias: 'o',
    requiresArg: true,
    nargs: 1,
    string: true,
    description: 'Save the body of the response to this file (use `-` to request stdout).',
  })
}

function addVerboseOption<T>(yargs: Argv<T>): Argv<T & { 'verbose'?: boolean }> {
  return yargs.option('verbose', { alias: 'v', nargs: 0, boolean: true, description: 'Log the outbound request' })
}

export function buildS3Commands(
  commandHandler: <Cmd extends AWSCommand<any, any, any>>(
    args: ArgumentsCamelCase,
    cmd: Cmd,
    moreHeaders?: Record<string, string>,
  ) => Promise<void> | void,
  yargs: Argv,
): Argv {
  return addVerboseOption(addAccountArg(addPresignArg(yargs)))
    .command('list-buckets', 'List the buckets currently created on your account.', (yargs) =>
      addHelp(yargs)
        .option('prefix', {
          alias: 'p',
          description: 'Only return buckets with the matching prefix.',
          requiresArg: true,
          nargs: 1,
          string: true,
        })
        .option('start-after', {
          description: 'Only returns buckets that are lexicographically after this string.',
          requiresArg: true,
          nargs: 1,
          string: true,
        })
        .option('continuation-token', {
          description: 'Resume listing from a previous continuation token.',
          requiresArg: true,
          nargs: 1,
          string: true,
        })
        .option('max-keys', {
          description: 'Limit the results to returning this many keys.',
          requiresArg: true,
          nargs: 1,
          number: true,
        }), (argv) =>
      commandHandler(
        argv,
        new S3.ListBucketsCommand({}),
        {
          ...(argv['prefix'] !== undefined && { 'cf-prefix': argv['prefix'] }),
          ...(argv['start-after'] !== undefined && { 'cf-start-after': argv['start-after'] }),
          ...(argv['continuation-token'] !== undefined && { 'cf-continuation-token': argv['continuation-token'] }),
          ...(argv['max-keys'] !== undefined && { 'cf-max-keys': argv['max-keys'].toString() }),
        },
      ))
    .group('list-buckets', 'Account')
    .command('create-bucket <bucket>', 'Create a new R2 bucket.', (yargs) =>
      addBucketArg(addHelp(yargs))
        .option('location', {
          alias: 'l',
          description: 'The location where to create the bucket.',
          requiresArg: true,
          nargs: 1,
          string: true,
        }), async (argv) =>
      commandHandler(
        argv,
        new S3.CreateBucketCommand({
          Bucket: argv['bucket'],
          ...(argv['location'] !== undefined &&
            { CreateBucketConfiguration: { LocationConstraint: argv['location'] } }),
        }),
      ))
    .group('create-bucket', 'Bucket')
    .command('head-bucket <bucket>', 'Check if an R2 bucket exists.', (yargs) =>
      addBucketArg(addHelp(yargs)), (argv) =>
      commandHandler(
        argv,
        new S3.HeadBucketCommand({ Bucket: argv['bucket'] }),
      ))
    .group('head-bucket', 'Bucket')
    .command('get-bucket-encryption <bucket>', 'Get the encryption currently set on the R2 bucket.', (yargs) =>
      addBucketArg(addHelp(yargs)), (argv) =>
      commandHandler(argv, new S3.GetBucketEncryptionCommand({ Bucket: argv['bucket'] })))
    .group('get-bucket-encryption', 'Bucket')
    .command('get-bucket-location <bucket>', 'Get the location of a R2 bucket.', (yargs) =>
      addBucketArg(addHelp(yargs)), (argv) =>
      commandHandler(
        argv,
        new S3.GetBucketLocationCommand({ Bucket: argv['bucket'] }),
      ))
    .group('get-bucket-location', 'Bucket')
    .command(
      'get-bucket-cors <bucket>',
      'Get the CORS rules associated with this R2 bucket.',
      (yargs) => addBucketArg(addHelp(yargs)),
      (argv) => commandHandler(argv, new S3.GetBucketCorsCommand({ Bucket: argv['bucket'] })),
    )
    .group('get-bucket-cors', 'Bucket')
    .command(
      'put-bucket-cors',
      'Set the CORS rules for this R2 bucket.',
      (yargs) => addBucketArg(addHelp(yargs)),
      (argv) => {
        throw new Error('put-bucket-cors not implemented')
      }, /*commandHandler(argv, new S3.PutBucketCorsCommand({ Bucket: argv['bucket'], CORSConfiguration: {
        CORSRules: []
      } }))*/
    )
    .group('put-bucket-cors <bucket>', 'Bucket')
    .command(
      'delete-bucket-cors <bucket>',
      'Delete the CORS rules for this R2 bucket.',
      (yargs) => addBucketArg(addHelp(yargs)),
      (argv) => commandHandler(argv, new S3.DeleteBucketCorsCommand({ Bucket: argv['bucket'] })),
    )
    .group('delete-bucket-cors', 'Bucket')
    .command('list-objects-v1 <bucket>', `List objects on this R2 bucket using S3's deprecated V1 API`, (yargs) =>
      addBucketArg(addHelp(yargs))
        .option('prefix', { nargs: 1, string: true, description: 'Only match keys that start with this value.' })
        .option('delimiter', {
          nargs: 1,
          string: true,
          description: 'Group keys by this value (use / to get a traditional hierarchical view of your objects).',
        })
        .option('url-encode', {
          nargs: 0,
          description:
            'Strings in the responses are rendered URL-encoded in case you are using an XML 1.0 parser and are processing unicode values.',
        })
        .option('max-keys', {
          nargs: 1,
          number: true,
          description: 'Provide an option in case you want fewer than 1000 objects returned.',
        })
        .option('marker', {
          nargs: 1,
          string: true,
          description:
            'Provide a string that all retrieved keys must be lexicographically larger than (see start-after in normal list-objects).',
        }), (argv) =>
      commandHandler(
        argv,
        new S3.ListObjectsCommand({
          Bucket: argv['bucket'],
          Prefix: argv['prefix'],
          Delimiter: argv['delimiter'],
          EncodingType: argv['url-encode'] ? 'url' : undefined,
          MaxKeys: argv['max-keys'],
          Marker: argv['marker'],
        }),
      ))
    .group('list-objects-v1', 'Bucket')
    .command('list-objects <bucket>', 'List objects on this R2 bucket using the recommended S3 API.', (yargs) =>
      addBucketArg(addHelp(yargs))
        .option('prefix', { nargs: 1, string: true, description: 'Only match keys that start with this value.' })
        .option('delimiter', {
          nargs: 1,
          string: true,
          description: 'Group keys by this value (use / to get a traditional hierarchical view of your objects).',
        })
        .option('url-encode', {
          nargs: 0,
          boolean: true,
          description:
            'Strings in the responses are rendered URL-encoded in case you are using an XML 1.0 parser and are processing unicode values.',
        })
        .option('max-keys', {
          nargs: 1,
          number: true,
          description: 'Provide an option in case you want fewer than 1000 objects returned.',
        })
        .option('start-after', {
          nargs: 1,
          string: true,
          description: 'Provide a string that all retrieved keys must be lexicographically larger than.',
        })
        .option('continuation-token', {
          nargs: 1,
          string: true,
          description: 'Continue where the last iteration left off on.',
        }), (argv) =>
      commandHandler(
        argv,
        new S3.ListObjectsV2Command({
          Bucket: argv['bucket'],
          Prefix: argv['prefix'],
          Delimiter: argv['delimiter'],
          EncodingType: argv['url-encode'] ? 'url' : undefined,
          MaxKeys: argv['max-keys'],
          ContinuationToken: argv['continuation-token'],
        }),
      ))
    .group('list-objects', 'Bucket')
    .command('head-object <bucket> <object>', 'Check if the object exists in the R2 bucket.', (yargs) =>
      addObjectArg(addBucketArg(addHelp(yargs)))
        .option('is-etag', {
          nargs: 1,
          string: true,
          description: 'Only returns a successful response if the provided ETag matches (If-Match header)',
        })
        .option('not-etag', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the provided ETag does not matches (If-None-Match header)',
        })
        .option('uploaded-before', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the specified object was uploaded before this date (If-Unmodified-Since header).',
        })
        .option('range', {
          nargs: 1,
          string: true,
          description: 'The range of the body to retrieve. Specified in HTTP Range syntax.',
        })
        .option('uploaded-after', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the specified object was uploaded after this date (If-Modified-Since header).',
        }), (argv) =>
      commandHandler(
        argv,
        new S3.HeadObjectCommand({
          Bucket: argv['bucket'],
          Key: argv['object'],
          Range: argv['range'],
          IfMatch: argv['is-etag'],
          IfNoneMatch: argv['not-etag'],
          IfModifiedSince: argv['uploaded-after'] ? new Date(argv['uploaded-after']) : undefined,
          IfUnmodifiedSince: argv['uploaded-before'] ? new Date(argv['uploaded-before']) : undefined,
        }),
      ))
    .group('head-object', 'Object')
    .command('get-object <bucket> <object>', 'Retrieve the object from the R2 bucket.', (yargs) =>
      addSaveOption(addObjectArg(addBucketArg(addHelp(yargs))))
        .option('range', {
          nargs: 1,
          string: true,
          description: 'The range of the body to retrieve. Specified in HTTP Range syntax.',
        })
        .option('is-etag', {
          nargs: 1,
          string: true,
          description: 'Only returns a successful response if the provided ETag matches (If-Match header)',
        })
        .option('not-etag', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the provided ETag does not matches (If-None-Match header)',
        })
        .option('uploaded-before', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the specified object was uploaded before this date (If-Unmodified-Since header).',
        })
        .option('uploaded-after', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the specified object was uploaded after this date (If-Modified-Since header).',
        })
        .option('response-cache-control', {
          nargs: 1,
          string: true,
          description: 'Override the response `cache-control` header that is returned in the response.',
        })
        .option('response-content-disposition', {
          nargs: 1,
          string: true,
          description: 'Override the response `content-disposition` header that is returned in the response.',
        })
        .option('response-content-encoding', {
          nargs: 1,
          string: true,
          description: 'Override the response `content-encoding` header that is returned in the response.',
        })
        .option('response-content-language', {
          nargs: 1,
          string: true,
          description: 'Override the response `content-language` header that is returned in the response.',
        })
        .option('response-content-type', {
          nargs: 1,
          string: true,
          description: 'Override the response `content-type` header that is returned in the response.',
        })
        .option('response-expires', {
          nargs: 1,
          string: true,
          description: 'Override the response `expires` header that is returned in the response.',
        }), (argv) =>
      commandHandler(
        argv,
        new S3.GetObjectCommand({
          Bucket: argv['bucket'],
          Key: argv['object'],
          Range: argv['range'],
          IfMatch: argv['is-etag'],
          IfNoneMatch: argv['not-etag'],
          IfModifiedSince: argv['uploaded-after'] ? new Date(argv['uploaded-after']) : undefined,
          IfUnmodifiedSince: argv['uploaded-before'] ? new Date(argv['uploaded-before']) : undefined,
          ResponseCacheControl: argv['response-cache-control'],
          ResponseContentDisposition: argv['response-content-disposition'],
          ResponseContentEncoding: argv['response-content-encoding'],
          ResponseContentLanguage: argv['response-content-language'],
          ResponseContentType: argv['response-content-type'],
          ResponseExpires: argv['response-expires'] ? new Date(argv['response-expires']) : undefined,
        }),
      ))
    .group('get-object', 'Object')
    .command('put-object <bucket> <object> [file|string]', 'Upload an object to the R2 bucket.', (yargs) =>
      addSaveOption(addObjectArg(addBucketArg(addHelp(yargs))))
        .positional('file', {
          type: 'string',
          description:
            'Unless --simple is provided, this is the filename. If not specified, then the object name is interpreted as the name of the file',
        })
        .option('simple', {
          boolean: true,
          nargs: 0,
          description: 'Treat the input argument as a string instead of a file name.',
        })
        .option('meta', {
          string: true,
          nargs: 1,
          array: true,
          description:
            'Supply k=v as an argument and this will send x-amz-meta-<k> with the value <v>. Can be specified repeatedly.',
          demandOption: true,
        })
        .option('is-etag', {
          nargs: 1,
          string: true,
          description: 'R2 only attempts the upload if the provided ETag matches (If-Match header)',
        })
        .option('not-etag', {
          nargs: 1,
          string: true,
          description: 'R2 only attempts the upload if the provided ETag does not matches (If-None-Match header)',
        })
        .option('uploaded-before', {
          nargs: 1,
          string: true,
          description:
            'R2 only attempts the upload if the specified object was uploaded before this date (If-Unmodified-Since header).',
        })
        .option('uploaded-after', {
          nargs: 1,
          string: true,
          description:
            'Only returns a successful response if the specified object was uploaded after this date (If-Modified-Since header).',
        })
        .option('cache-control', {
          nargs: 1,
          string: true,
          description:
            'Set the `cache-control` metadata header for this object which is rendered when the file is retrieved (unless overridden).',
        })
        .option('content-disposition', {
          nargs: 1,
          string: true,
          description:
            'Set the `content-disposition` metadata header for this object which is rendered when the file is retrieved (unless overridden).',
        })
        .option('content-encoding', {
          nargs: 1,
          string: true,
          description:
            'Set the `content-encoding` metadata header for this object which is rendered when the file is retrieved (unless overridden).',
        })
        .option('content-language', {
          nargs: 1,
          string: true,
          description:
            'Set the `content-language` metadata header for this object which is rendered when the file is retrieved (unless overridden).',
        })
        .option('content-type', {
          nargs: 1,
          string: true,
          description:
            'Set the `content-type` metadata header for this object which is rendered when the file is retrieved (unless overridden).',
        })
        .option('expires', {
          nargs: 1,
          string: true,
          description:
            'Set the `expires` metadata header for this object which is rendered when the file is retrieved (unless overridden).',
        }), (argv) =>
      commandHandler(
        argv,
        new S3.PutObjectCommand({
          Bucket: argv['bucket'],
          Key: argv['object'],
          Body: (() => {
            if (argv['simple']) {
              if (argv.file === undefined) {
                throw new Error('--simple provided but no value provided')
              }
              return argv
                .file
            }

            // Can't interpret `-` because the file size is required.
            return createReadStream(argv.file ?? argv.object, 'binary')
          })(),
          ContentLength: (() => {
            if (argv['simple']) { return undefined }
            return statSync(
              argv.file ?? argv
                .object,
            )
              .size
          })(),
          CacheControl: argv['cache-control'],
          ContentDisposition: argv['content-disposition'],
          ContentEncoding: argv['content-encoding'],
          ContentLanguage: argv['content-language'],
          ContentType: argv['content-type'],
          Expires: argv['expires'] ? new Date(argv['expires']) : undefined,
          Metadata: Object.fromEntries(argv['meta'].map((kv) => {
            if (!kv.includes('=')) {
              throw new Error(`Bad metadata '${kv}' - missing '=' between key and value`)
            }
            const [key, ...rest] = kv
              .split('=')
            return [
              key,
              rest.join('='),
            ]
          })),
        }),
        {
          ...(argv['is-etag'] && { 'IfMatch': argv['is-etag'] }),
          ...(argv['not-etag'] && { 'IfNoneMatch': argv['not-etag'] }),
          ...(argv['uploaded-after'] && { 'IfModifiedSince': argv['uploaded-before'] }),
          ...(argv['uploaded-before'] && { 'IfUnmodifiedSince': argv['uploaded-before'] }),
        },
      ))
    .group('get-object', 'Object')
    .strict()
    .help('h')
    .alias('h', 'help')
    .demandCommand()
}

function addHeaders<Input extends S3.ServiceInputTypes, Output extends S3.ServiceOutputTypes>(
  request: AWSCommand<Input, Output, S3.S3ClientResolvedConfig>,
  headers: HeadersInit,
): AWSCommand<Input, Output, S3.S3ClientResolvedConfig> {
  request.middlewareStack.add((next) => (argv): Promise<AWSTypes.BuildHandlerOutput<Output>> => {
    // Annoyingly the type information is unusable for adding middleware AFAICT.
    const r = argv.request as RequestInit & { headers: Record<string, string> }

    Object.entries(headers).forEach(([k, v]: [key: string, value: string]): void => {
      r.headers[k] = v
    })

    return next(argv)
  }, { step: 'build', name: 'customHeaders' })
  return request
}

export type GenericCmdArgs = {
  verbose?: boolean
  account?: string
  bucket?: string
  object?: string
  presign: boolean
  'save-body-to'?: string
  'expires-in'?: number
  'sign-header'?: string | string[]
}

function addPresignArg<T>(yargs: Argv<T>): Argv<T> {
  return yargs
    .option('presign', {
      description: 'Generate a pre-signed URL for this command.',
      nargs: 0,
      boolean: true,
      implies: 'expires-in',
    })
    .option('expires-in', {
      description:
        'After this many seconds in the future, the signed URL will stop working. Default is 1 day. Maximum is 7 days.',
      nargs: 1,
      requiresArg: true,
      number: true,
      default: 86400,
    })
    .option('sign-header', {
      description:
        'Specify as many times with an argument of key=value to sign the headers to require this key and value (can just keep applying key=value or specify --sign-header multiple times). Failing to supply these exact headers and values in the request will cause it to fail.',
      string: true,
      nargs: 1,
    })
    .strict()
}

export async function handleS3Cmd<Command extends AWSCommand<any, any, any>>(
  argv: ArgumentsCamelCase<GenericCmdArgs>,
  command: Command,
  progressBarCreator: ProgressBarCreator,
  headers?: Record<string, string>,
): Promise<void> {
  if (headers === undefined) {
    headers = {}
  }

  const config = argv['account'] ? await retrieveConfig(argv['account']) : await retrieveOnlyConfig()
  if (config.err) {
    process.exitCode = 1
    return
  }

  const client = new S3.S3({
    region: 'auto',
    endpoint: `https://${config.val.account_id}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.val.access_key_id, secretAccessKey: config.val.secret_access_key },
    forcePathStyle: true,
  })

  if (argv.verbose) {
    client.middlewareStack.add((next, context) => async (args) => {
      const request = args.request as {
        method: string
        protocol: string
        hostname: string
        query?: Record<string, string>
        headers?: Record<string, string>
        path: string
      }

      const url = new URL(`${request.protocol}//${request.hostname}${request.path}`)
      for (const [k, v] of Object.entries(request.query ?? {})) {
        url.searchParams.set(k, v)
      }

      const curlHeaderArgs = Object.entries(request.headers ?? {}).flatMap(([k, v]) => ['-H', `'${k}: ${v}'`])

      let serializedHeaderArgs = curlHeaderArgs.length === 0 ? '' : ' ' + colors.blue(curlHeaderArgs.join(' '))

      let serializedCommandName = colors.green(context['commandName'])
      let serializedMethod = colors.red(`-X ${request.method}`)
      let serializedUrl = colors.grey(url.toString())

      console.debug(`${serializedCommandName}: curl ${serializedMethod}${serializedHeaderArgs} '${serializedUrl}'`)

      return await next(args)
    }, { name: 'logRequest', step: 'finalizeRequest', priority: 'low' })
  }

  if (argv.presign) {
    const now = new Date()
    const expiryInXSeconds = argv['expires-in']!
    const expiryDate = new Date(now.getTime() + expiryInXSeconds * 1000)

    if (argv['sign-header']) {
      if (typeof argv['sign-header'] === 'string') {
        argv['sign-header'] = [argv['sign-header']]
      }
      for (const [k, v] of argv['sign-header'].map((kv) => kv.split('='))) {
        headers[k] = v
      }
    }
    addHeaders(command, headers)

    let method: 'GET' | 'HEAD' | 'PUT' | 'DELETE'
    if (command.constructor.name.startsWith('Put')) {
      method = 'GET'
    } else if (command.constructor.name.startsWith('Delete')) {
      method = 'DELETE'
    } else if (command.constructor.name.startsWith('Head')) {
      method = 'HEAD'
    } else {
      method = 'GET'
    }

    const presignedUrl = await getSignedUrl(client, command, {
      expiresIn: expiryInXSeconds,
      'signableHeaders': headers ? new Set(Object.keys(headers)) : undefined,
      signingDate: now,
    })

    const curlArgs = ['curl', '-X', method]
    for (const [k, v] of Object.entries(headers)) {
      curlArgs.push('-H')
      curlArgs.push(`'${k}: ${v}'`)
    }
    curlArgs.push(`'${presignedUrl}'`)

    console.info()
    console.info(`URL expires ${expiryDate.toUTCString()}`)
    console.info()
    process.stdout.write(curlArgs.join(' '))
    if (process.stdout.isTTY) {
      process.stdout.write('\n')
    }
    return
  }

  let body: IncomingMessage | undefined
  let bodyLength: number | undefined
  try {
    const response = await client.send(addHeaders(command, headers)) as {
      Body?: IncomingMessage
      ContentLength?: number
    }
    body = response.Body
    bodyLength = response.ContentLength
    delete response['Body']
    console.info(inspect(response, { depth: null, colors: true }))
  } catch (e) {
    const err = (e as Error & AWSTypes.MetadataBearer)
    console.error(`Failed ${argv._.join(' ')}: ${err['$metadata']['httpStatusCode']} ${err.message}`)
    process.exitCode = 1
    return
  }

  if (body !== undefined) {
    if (argv['save-body-to'] === undefined) {
      if (argv['object'] !== undefined) {
        // Infer the save location
        let inferredSavePath = argv['object'].split('/').at(-1)!
        argv['save-body-to'] = inferredSavePath
      } else {
        console.warn('The response from the request is not saved - please specify --save/-o')
        return
      }
    }

    if (argv['save-body-to'] !== '-') {
      try {
        accessSync(argv['save-body-to'], constants.W_OK)

        const prompt = inquirer.createPromptModule()
        const answer = await prompt({
          name: 'overwrite',
          message: `${argv['save-body-to']} already exists and --save-body-to/-o was not provided. Overwrite?`,
          type: 'confirm',
          default: false,
        })
        if (!answer.overwrite) {
          return
        }
      } catch (e) {
        if (Object.prototype.hasOwnProperty.call(e, 'code') && (e as NodeJS.ErrnoException).code === 'ENOENT') {
          // Creating a new file is fine.
        } else {
          console.error(`Unrecognized error trying to save to inferred location from object name.`, e)
          process.exitCode = 1
          return
        }
      }
    }

    // TODO(later): If dumping to stdout and stdout is connected to a TTY, prompt confirmation when file is > some threshold.

    let output = argv['save-body-to'] !== '-' ?
      createWriteStream(argv['save-body-to'], { encoding: 'binary' }) :
      process.stdout

    if (bodyLength !== undefined && argv['save-body-to'] !== '-') {
      const progressBar = progressBarCreator({ description: argv['save-body-to'] })
      progressBar.start(bodyLength, 0, { speed: 'N/A' })

      const speedFormat = sizeFormatter({ std: 'IEC', decimalPlaces: 2, keepTrailingZeroes: false })

      let measurementStart = Date.now()
      await pipeline(
        body,
        new Transform({
          transform(chunk, encoding, callback) {
            const elapsedSeconds = (Date.now() - measurementStart) / 1000
            const bytesTransferred = chunk.length
            const throughput = bytesTransferred / elapsedSeconds

            progressBar.increment(chunk.length, { speed: `${speedFormat(throughput)}/s` })
            this.push(chunk, encoding)
            callback()
          },
        }),
        output,
      )

      progressBar.stop()
    } else {
      body!.pipe(output)

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          body!.once('end', resolve)
          body!.once('error', reject)
        }),
        new Promise<void>((resolve, reject) => {
          output.once('end', resolve)
          output.once('error', reject)
        }),
      ])
    }
  }
}
