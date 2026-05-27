# Docker Deployment

The Docker image exposes the backup proxy on port `7860`, which is the public
entrypoint for Hugging Face Spaces. The original app runs internally on port
`4173`.

## Environment

Required rclone configuration is provided by environment variables. The default
backup destination is:

```text
REMOTE_FOLDER=huggingface:notes
```

The backup file is always:

```text
${REMOTE_FOLDER}/notes.db
```

There are two supported ways to provide rclone configuration.

### Option 1: rclone.conf secret

Preferred for Hugging Face Secrets:

```text
RCLONE_CONF=<raw rclone.conf content>
```

The entrypoint writes it to:

```text
/root/.config/rclone/rclone.conf
```

Compatibility options are also supported:

```text
RCLONE_CONFIG_BASE64=<base64 encoded rclone.conf>
RCLONE_CONFIG_CONTENT=<raw rclone.conf content>
```

### Option 2: rclone environment remote config

Configure the `huggingface` rclone remote with rclone environment variables,
for example:

```text
RCLONE_CONFIG_HUGGINGFACE_TYPE=...
RCLONE_CONFIG_HUGGINGFACE_...=...
```

The exact variables depend on the rclone backend used for the remote.

## Startup Restore

On container startup, the entrypoint checks whether this file exists:

```text
${REMOTE_FOLDER}/notes.db
```

If it exists, it is restored to:

```text
data/notes.db
```

If it does not exist, the app starts as a first install and initializes a new
database.

## Manual Backup

The backup proxy injects a backup button into the page. Clicking it calls:

```text
POST /api/backup/run
```

The proxy verifies the current session with the app before running the backup.
Unauthenticated users receive `401`.

The server does not accept any command, path, or remote from the browser. The
backup target is fixed by `REMOTE_FOLDER`, and only one remote file is kept:

```text
notes.db
```

Uploads use a temporary remote file first:

```text
notes.db.uploading
```

Then it is moved into place as `notes.db`.
