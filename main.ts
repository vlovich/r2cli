import colors from 'ansi-colors'
import cliProgress from 'cli-progress'
import process from 'node:process'
import { ArgumentsCamelCase } from 'yargs'
import yargs from 'yargs/yargs'
import { importConfig, initConfigCommand, listConfigsCommand, listCredsCommand as listCredsCommand, removeConfigCommand, removeCredCommand } from './config'
import { buildS3Commands, GenericCmdArgs, handleS3Cmd } from './s3'

interface ProgressBarOptions {
  description: string
}
export type ProgressBarCreator = (options: ProgressBarOptions) => cliProgress.GenericBar

const argv =
  yargs(process.argv.slice(2))
    .usage('Usage: r2 <command> [options]')
    .version('1.0')
    .command(['config', 'cfg'], 'Work with the configuration', (yargs) => {
      yargs
        .command('import', 'Import your configuration from another tool', (yargs) => {
          yargs.option('r', { alias: 'rclone' })
        }, importConfig)
        .command(['add <name> <account>', 'init'], 'Add an R2 account profile', (yargs) => {
          yargs
            .positional('name', {
              describe: 'The name of the profile',
              requiresArg: true,
              type: 'string',
              demandOption: true,
            })
            .positional('account', {
              describe: 'The Cloudflare account ID with an R2 subscription',
              type: 'string',
              demandOption: true,
            })
            .demandOption(['name', 'account'])
        }, initConfigCommand)
        .command('rm <name|account>', 'Remove by profile name or account', (yargs) => {
          yargs.positional('name', {
            type: 'string',
            description:
              'The name of the profile or the account id. If multiple profiles match the account id you will be prompted which one to remove.',
            demandOption: true,
          })
        }, removeConfigCommand)
        .command(['list', 'ls'], 'List R2 accounts that are configured', () => {}, listConfigsCommand)
        .command('list-creds <account>', 'List all R2 credentials saved', (yargs) => {
          yargs.positional('account', {
            type: 'string',
            description: 'The Cloudflare account ID to list saved R2 tokens for',
            demandOption: true,
          })
        }, listCredsCommand)
        .command('rm-cred <account> [access-key-id]', 'List all R2 credentials saved', (yargs) => {
          yargs
            .positional('account', {
              type: 'string',
              description: 'The Cloudflare account ID to list saved R2 tokens for',
              demandOption: true,
            })
            .positional('access-key-id', {
              type: 'string',
              description:
                'The token ID to remove. If not specified you will be prompted to confirm which one to remove.',
            })
        }, removeCredCommand)
        .demandCommand(1, 1)
        .help('h')
        .alias('h', 'help')
        .showHelpOnFail(true)
        .strict()
    })
    .command('s3', 'Perform an action against the S3 endpoint', (yargs) => {
      buildS3Commands((argv, cmd, moreHeaders) =>
        handleS3Cmd(argv as ArgumentsCamelCase<GenericCmdArgs>, cmd, (options) => {
          const bar = new cliProgress
            .SingleBar({
            format: `${options.description} | ${
              colors.cyan('{bar}')
            } | {percentage}% | {value}/{total} | {eta_formatted} | {speed}`,
          }, cliProgress.Presets.shades_classic)
          return bar
        }, moreHeaders)
          .then(() => process.exit()), yargs)
    })
    .demandCommand(1, 1)
    .strict()
    .help('h')
    .alias('h', 'help')
    .showHelpOnFail(true)
    .argv
