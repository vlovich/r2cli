import process from 'node:process'
import { Err, Ok, Result } from 'ts-results'
import { ArgumentsCamelCase } from 'yargs'
import yargs from 'yargs/yargs'
import { importConfig, initConfig, listConfigs } from './config'
import { buildS3Commands, GenericCmdArgs, handleS3Cmd } from './s3'

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
        .command(['list', 'ls'], 'List R2 accounts that are configured', () => {}, listConfigs)
        .demandCommand(1, 1)
        .help('h')
        .alias('h', 'help')
        .showHelpOnFail(true)
        .strict()
    })
    .command('s3', 'Perform an action against the S3 endpoint', (yargs) => {
      buildS3Commands((argv, cmd, moreHeaders) =>
        handleS3Cmd(argv as ArgumentsCamelCase<GenericCmdArgs>, cmd, moreHeaders), yargs)
    })
    .demandCommand(1, 1)
    .strict()
    .help('h')
    .alias('h', 'help')
    .showHelpOnFail(true)
    .argv
