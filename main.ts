import * as S3 from '@aws-sdk/client-s3'
import { EndpointParameterInstructions } from '@aws-sdk/middleware-endpoint'
import TOML from '@iarna/toml'
import getos from 'getos'
import { parse as parseINI } from 'ini'
import inquirer from 'inquirer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import tsresults from 'ts-results'
import { Result } from 'ts-results'
const { Err, Ok } = tsresults
import { getType } from 'tst-reflect'
import { ArgumentsCamelCase } from 'yargs'
import yargs from 'yargs/yargs'

async function touchPath(p: string): Promise<void> {
  const fd = await new Promise<number>((resolve, reject) =>
    fs.open(p, 'a', undefined, (err, fd) => {
      if (err) {
        reject(err)
      } else {
        resolve(fd)
      }
    })
  )

  return new Promise<void>((resolve, reject) => {
    fs.close(fd, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

async function readTextFile(p: string): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise<string>((resolve, reject) => {
    fs.readFile(p, { encoding: 'utf8' }, (err, data) => {
      if (err) { reject(err) }
      resolve(data)
    })
  })
}

async function writeTextFile(p: string, contents: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fs.writeFile(p, contents, { encoding: 'utf8' }, (err) => {
      if (err) { reject(err) }
      resolve()
    })
  })
}

class CandidatePaths {
  private readonly projectFolder: string
  private readonly local: string
  private readonly winAppDataPath: string | undefined
  private readonly xdgConfigPath: string | undefined
  private readonly homePaths: string[]

  constructor(projectFolder: string, configName: string) {
    this.projectFolder = projectFolder

    this.local = `${configName}`
    if (process.platform === 'win32' && process.env['APPDATA']) {
      this.winAppDataPath = `${process.env['APPDATA']}/${projectFolder}/${configName}`
    }
    if (process.env['XDG_CONFIG_HOME']) {
      this.xdgConfigPath = `${process.env['XDG_CONFIG_HOME']}/${projectFolder}/${configName}`
    }

    let home = process.env['HOME'] ||
      process.env['USERPROFILE'] ||
      (process.env['HOMEDRIVE'] && process.env['HOMEPATH'] ?
        path.join(process.env['HOMEDRIVE'], process.env['HOMEPATH']) :
        undefined)

    if (home !== undefined) {
      this.homePaths = [`${home}/.config/${projectFolder}/${configName}`, `${home}/.${configName}`]
    } else {
      this.homePaths = []
    }
  }

  get candidatePaths(): string[] {
    return [this.local, this.winAppDataPath, this.xdgConfigPath, ...this.homePaths].flatMap((v) =>
      v !== undefined ? [v] : []
    )
  }

  async findExistingConfig(): Promise<string | undefined> {
    for (const p of [this.local, this.winAppDataPath, this.xdgConfigPath, ...this.homePaths]) {
      if (p === undefined) {
        continue
      }

      const exists = await new Promise<boolean>((resolve) =>
        fs.access(p, fs.constants.R_OK, (err) => err ? resolve(false) : resolve(true))
      )
      if (exists) {
        return p
      }
    }

    return undefined
  }

  async createInitialConfig(): Promise<Result<string, Error>> {
    if (this.projectFolder !== 'cloudflare') {
      throw new Error(`Attempt to touch someone else's project`)
    }

    let candidatePaths = []
    if (process.platform === 'win32') {
      candidatePaths.push(this.winAppDataPath)
      candidatePaths.push(this.homePaths[0])
    } else {
      candidatePaths.push(this.xdgConfigPath)
      candidatePaths.push(this.homePaths[0])
    }

    for (const p of candidatePaths) {
      if (p === undefined) {
        continue
      }

      const parentDir = path.dirname(p)
      try {
        await new Promise<void>((resolve, reject) => fs.mkdir(parentDir, (err) => err ? reject(err) : resolve()))
      } catch (e) {
        if (Object.prototype.hasOwnProperty.call(e, 'code') && (e as NodeJS.ErrnoException).code !== 'EEXIST') {
          console.warn('Trouble creating path', parentDir, e)
          continue
        }
      }

      // Touch the file
      try {
        await touchPath(p)
      } catch (e) {
        console.warn('Trouble touching config path', p, e)
        continue
      }
      return Ok(p)
    }

    if (this.homePaths[1]) {
      const p = this.homePaths[1]
      try {
        await touchPath(p)
        return Ok(p)
      } catch (e) {
        console.warn('Trouble touching config path', p, e)
      }
    }

    return Err(new Error('Failed on all possible candidate paths'))
  }
}

function accountForR2URL(r2Url: string): string {
  const url = new URL(r2Url)
  return url.hostname.split('.')[0]
}

interface Config {
  profile: string
  account_id: string
  access_key_id: string
  secret_access_key: string
}

async function saveCreds(config: Omit<Config, 'profile'>): Promise<void> {
  let distro = await new Promise<getos.Os>((resolve, reject) => {
    getos((e, os) => {
      if (e) { reject(e) }
      else { resolve(os) }
    })
  })

  if (distro.os === 'linux') {
    const libsecretFile = '/usr/lib/libsecret-1.so'
    if (!fs.existsSync(libsecretFile)) {
      let installCommand = (() => {
        switch (distro.dist) {
          case 'Arch Linux':
            return ['pacman', '-S', 'libsecret']
          case 'Ubuntu':
          case 'Debian GNU/Linux':
            return ['pacman', '-S', 'libsecret-1-dev']
          case 'Fedora':
            return ['yum', 'install', 'libsecret-devel']
          default:
            console.error(
              `libsecret doesn't appear to be installed and not a currently supported Linux distribution at this time`,
            )
            return undefined
        }
      })()
      if (installCommand === undefined) {
        process.exitCode = 1
        return
      }

      console.log(
        `Running ${
          ['/usr/bin/sudo', ...installCommand].join(' ')
        } to install libsecret. You may be prompted for a password.`,
      )

      execFileSync('/usr/bin/sudo', installCommand, { encoding: 'utf-8' })
    }
  }

  const keytar = (await import('keytar')).default

  const endpoint = `https://${config.account_id}.r2.cloudflarestorage.com`

  console.log(`Validating credential ${config.access_key_id} for ${endpoint}`)

  const s3 = new S3.S3({
    endpoint,
    credentials: { accessKeyId: config.access_key_id, secretAccessKey: config.secret_access_key },
  })

  try {
    await s3.listBuckets({})
  } catch (e) {
    console.error('Credentials failed to validate.', (e as Error).message)
    process.exit(1)
  }

  console.log(
    `Securely saving R2 token with id ${config.access_key_id} for ${endpoint} in your OS encrypted password storage.`,
  )

  await keytar.setPassword(endpoint, config.access_key_id, config.secret_access_key)
}

async function importConfig(argv: ArgumentsCamelCase): Promise<void> {
  const r2ConfigPaths = new CandidatePaths('cloudflare', 'r2.toml')
  const configFilePath = (await r2ConfigPaths.createInitialConfig()).unwrap()
  const existingConfig = TOML.parse(await readTextFile(configFilePath))

  let importSource
  let numConfigurationsImported = 0

  if (argv['rclone']) {
    importSource = 'rclone'

    const rclonePaths = new CandidatePaths('rclone', 'rclone.conf')
    const rcloneConfigFile = await rclonePaths.findExistingConfig()
    if (rcloneConfigFile === undefined) {
      console.error(`No existing rclone configuration found in ${rclonePaths.candidatePaths.join(', ')}`)
      process.exitCode = 1
      return
    }

    let rcloneConfig = await (async (): Promise<Record<string, Record<string, string>> | undefined> => {
      try {
        return parseINI(await readTextFile(rcloneConfigFile))
      } catch (e) {
        console.error('Trouble parsing rclone config file', rcloneConfigFile, e)
        process.exitCode = 1
        return undefined
      }
    })()
    if (rcloneConfig === undefined) {
      return
    }

    const r2Profiles: Record<string, Record<string, string>> = {}

    for (const [profileName, profile] of Object.entries(rcloneConfig)) {
      if (profile['endpoint'].endsWith('.r2.cloudflarestorage.com')) {
        r2Profiles[profileName] = profile
      }
    }

    switch (Object.keys(r2Profiles).length) {
      case 0:
        console.error('No Cloudflare R2 profiles found in', rcloneConfigFile)
        process.exitCode = 1
        return
      default:
        numConfigurationsImported = Object.keys(r2Profiles).length
        for (const [name, details] of Object.entries(r2Profiles)) {
          console.log(`Importing RClone configuration ${name}`)
          await saveCreds({
            account_id: accountForR2URL(details['endpoint']),
            access_key_id: details['access_key_id'],
            secret_access_key: details['secret_access_key'],
          })
          existingConfig[name] = {
            account_id: accountForR2URL(details['endpoint']),
            access_key_id: details['access_key_id'],
          }
        }
    }
  } else {
    console.error('No import source provided')
    process.exitCode = 1
    return
  }

  await writeTextFile(configFilePath, TOML.stringify(existingConfig))

  console.info(`Imported ${numConfigurationsImported} ${importSource} configurations into ${configFilePath}`)
}

async function initConfig(argv: ArgumentsCamelCase): Promise<void> {
  // TODO: It would be nice to just navigate you through available accounts like wrangler does.
  // TODO: Use wrangler creds from ~/.wrangler/config/default.toml to communicate with the API.
  const name = argv['name'] as string
  const account_id = argv['account'] as string

  console.info(`Tokens can be generated at https://dash.cloudflare.com/${account_id}/r2/api-tokens`)

  const prompt = inquirer.createPromptModule()
  const { access_key_id, secret_access_key } = await prompt([{
    name: 'access_key_id',
    message: 'What is the "Access Key ID" of your token?',
  }, { name: 'secret_access_key', message: 'What is the "Secret Access Key" of your token?' }])

  const r2ConfigPaths = new CandidatePaths('cloudflare', 'r2.toml')
  const configFilePath = (await r2ConfigPaths.createInitialConfig()).unwrap()
  const existingConfig = TOML.parse(await readTextFile(configFilePath))

  await saveCreds({ account_id, access_key_id, secret_access_key })

  existingConfig[name] = { account: account_id, access_key_id: access_key_id }

  await writeTextFile(configFilePath, TOML.stringify(existingConfig))

  console.info(`Added configuration ${name} to ${configFilePath}`)
}

async function s3cmd(argv: ArgumentsCamelCase): Promise<void> {
}

interface S3CommandDescriptor {
  getEndpointParameterInstructions(): EndpointParameterInstructions
}

//const type = getType<S3.AbortMultipartUploadCommand>()
//console.error(type, type.getConstructors())

function commandToCommandLine(
  command: [string, S3CommandDescriptor],
): { name: string; cmdGroup: 'account' | 'bucket' | 'object'; cmd: S3CommandDescriptor } {
  let parameters = command[1].getEndpointParameterInstructions()
  let cmdGroup: 'account' | 'bucket' | 'object'
  if (!('Bucket' in parameters)) {
    cmdGroup = 'account'
  } else if (!('Object' in parameters)) {
    cmdGroup = 'bucket'
  } else {
    cmdGroup = 'object'
  }

  return {
    name: command[0].slice(0, command[0].length - 'Command'.length).replace(/([a-zA-Z])(?=[A-Z])/g, '$1-')
      .toLowerCase(),
    cmdGroup,
    cmd: command[1],
  }
}

const argv =
  yargs(process.argv.slice(2))
    .usage('Usage: r2 <command> [options]')
    .version('1.0')
    .command(['config', 'cfg'], 'Work with the configuration', (yargs) => {
      yargs
        .command('import', 'Import your configuration from another tool', (yargs) => {
          yargs.option('r', { alias: 'rclone' })
        }, importConfig)
        .command(['add', 'init'], 'Add an R2 account profile', (yargs) => {
          yargs
            .option('name', { describe: 'The name of the profile', requiresArg: true, type: 'string' })
            .option('account', {
              alias: 'a',
              describe: 'The Cloudflare account ID with an R2 subscription',
              requiresArg: true,
              type: 'string',
            })
            .demandOption(['name', 'account'])
        }, initConfig)
        .demandCommand(1, 1)
        .help('h')
        .alias('h', 'help')
        .showHelpOnFail(true)
        .strict()
    })
    .command('s3', 'Perform an action against the S3 endpoint', (yargs) => {
      Object.getOwnPropertySymbols
      const commandList = Object
        .entries(Object.getOwnPropertyDescriptors(S3))
        .flatMap(([name, descriptor]): [string, S3CommandDescriptor][] =>
          name.endsWith('Command') && !name.endsWith('ResponseCommand') ?
            [[name, descriptor.get!() as S3CommandDescriptor]] :
            []
        )
        .map((x) => commandToCommandLine(x))
      for (const command of commandList) {
        yargs.command(command.name, 'some command')
        yargs.group(command.name, command.cmdGroup)
      }
      yargs.demandCommand(1, 1)
    }, s3cmd)
    .demandCommand(1, 1)
    .strict()
    .help('h')
    .alias('h', 'help')
    .showHelpOnFail(true)
    .argv
