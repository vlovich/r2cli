# Installing

**TODO**: There's currently no npm package for this because I haven't figured out how to bundle keytar
correctly. Contribution welcome.

```
git clone https://github.com/vlovich/r2cli.git
cd r2cli
npm ci
```

# Configuring

## Copying rclone creds

- `npm run main -- config import --rclone`

If there's at least one rclone profile and all import successfully (i.e. tokens are valid), then
the command will exit without an error. `npm run main -- config ls` can be used to view the list
of credentials imported.

## Setting up from scratch

Create a profile named "personal":

- Visit https://dash.cloudflare.com/<account>/r2/overview/api-tokens
- Click the "Create API token" button at the top of the page.
- Configure the permissions of the token.
- Click the "Create API token" button at the bottom of the page.
- Run `npm run main -- config add personal <account>`
- For the prompted "Access Key ID", copy-paste the "Access Key ID" of the generated token.
- For the prompted "Secret Access Key", copy-paste the "Secret Access Key" of the generated token.

If the token validates the command should exit without an error (the profile should be listed under
`npm run main -- config ls`).

# Running an S3 command

The set of supported actions is visible by running `npm run main -- s3 --help`. If you have more
than one profile installed, you will get an interactive prompt to select the profile to use. If you
don't want a prompt (e.g. running non-interactively), then use `npm run main -- s3 --account <cloudflare account or profile name> <command> ...`.

For example, to list buckets, `npm run main -- s3 list-buckets`. Each command itself understands `--help`
so that you can further view the configuration options for that command.

## Generating presigned URLs

You can also pass in `--presign` between `s3` and the `<command>` which will print a `curl` command you can copy-paste
on a command-line.

### Options

#### Expiry

`--expires-in` is used to specify an integer number of seconds for the presigned URL to remain valid. Default is 1 day.

Example: `npm run main -- s3 --presign --expires-in 10 list-buckets` will generate a URL valid for 10 seconds.

### Enforcing headers are submitted with request

If you want to enforce that the user submit the request for the URL with specific header keys and values, specify
`--sign-header` as many times as you want with `key=value` to enforce that the submitted request contains the
given header and name. Any other headers will be accepted without a signature.

Example: `npm run main -- s3 --presign --sign-header content-type=application/json --sign-header "expires=Thu, 01 Dec 1994 16:00:00 GMT"`
will require that the subsequent curl command is invoked with `-H "content-type: application/json" -H "expires: Thu, 01 Dec 1994 16:00:00 GMT"`.
Note that the "expires" header here sets the value that wil be returned in the "Expires" HTTP header when the object is retrieved. This controls
caching expiry and is not a TTL parameter.

NOTE: There's no way to preclude the user from including extra headers that are honored. For example, in the above request
the user is allowed to add `-H "x-amz-meta-abc=5" -H "cache-control: max-age=0, must-revalidate"` which will cause the
custom metadata key named `abc` to have the value `5` and the system metadata header `cache-control` to be set with a setting
that will always force revalidation of the cache.
