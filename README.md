# wpress-toolkit

Inspect, extract, and transfer files from **All-in-One WP Migration** `.wpress`
archives — without unpacking the whole thing.

`.wpress` is the backup format produced by the popular *All-in-One WP Migration*
WordPress plugin. It is **not** a zip or tar file — it's a flat, custom
container. This toolkit reads that format directly and gives you:

- a `wpress` CLI to **list**, **cat**, **extract**, and **tar-stream** files,
- two transfer helpers that move a directory (e.g. `uploads`) to a server while
  using **almost no local disk**, designed for large archives where a full
  extract isn't practical.

It is dependency-free: the CLI is a single Node script using only the standard
library; the helpers are plain Bash around it.

---

## Why

A `.wpress` backup of a real site can be tens of gigabytes, with `uploads/`
accounting for the vast majority. Common needs that a "just unzip it" tool
can't handle well:

- peek inside without extracting 40k files,
- pull a single file (a `wp-config.php`, the `database.sql`),
- push just `wp-content/uploads` to a host **without** first extracting the
  whole archive to local disk,
- work within host limits (e.g. Pantheon rejects large files / disallows remote
  shell exec).

---

## Requirements

- **Node.js ≥ 14** — for the `wpress` CLI (works on macOS, Linux, Windows).
- **Bash + rsync/ssh** — for the `wpress-rsync` / `wpress-ssh` helpers
  (macOS, Linux, or WSL). The helpers shell out to your local `rsync`, `ssh`,
  and optionally `pv`.

---

## Install

Global (gives you `wpress`, `wpress-rsync`, `wpress-ssh` on your PATH):

```bash
npm install -g wpress-toolkit
```

One-off without installing:

```bash
npx wpress-toolkit list backup.wpress
```

From a clone (for development):

```bash
git clone https://github.com/kanopi/wpress-toolkit.git
cd wpress-toolkit
node wpress.js help
# or: npm link   (symlinks the bins globally)
```

> The shell helpers find `wpress.js` next to themselves automatically (even via
> npm's symlinks). You can always override the location with `WPRESS_JS=/path/to/wpress.js`.

---

## The `wpress` CLI

```
wpress list         <archive.wpress> [path] [-l|--long] [-R|--recursive]
wpress cat          <archive.wpress> <name|path> [more...]
wpress tar          <archive.wpress> <name|dir> [more...] [--strip prefix]
wpress manifest     <archive.wpress> [path]
wpress extract      <archive.wpress> [output-dir] [-f|--force]
wpress extract-file <archive.wpress> <name|glob> [more...] [-o out-dir] [--flat] [--from FILE] [-n]
```

Run `wpress help` for the full built-in reference.

### list — browse like `ls`

Shows the immediate contents of the archive root, or of a path you give.
Subfolders appear once with a trailing `/` and a file count.

```bash
wpress list backup.wpress                 # top level
wpress list backup.wpress uploads/2022 -l # one folder, with sizes + dates
wpress list backup.wpress -R | grep wp-config   # -R = recursive flat list
```

### cat — print a file to stdout

```bash
wpress cat backup.wpress wp-config.php
wpress cat backup.wpress database.sql | grep -i 'CREATE TABLE'
```

### extract — unpack the whole archive

```bash
wpress extract backup.wpress ./site          # dir defaults to the archive name
wpress extract backup.wpress ./site --force  # allow a non-empty output dir
```

### extract-file — pull individual files or directories

Patterns are anchored at the archive root, like `unzip`:

| Pattern | Matches |
|---|---|
| `index.php` | only the **root** `index.php` |
| `uploads/2022` | the whole `uploads/2022` tree |
| `uploads/2022/*.pdf` | PDFs directly in that folder (`*` stays within a folder) |
| `**/index.php` | every `index.php`, at any depth |

```bash
wpress extract-file backup.wpress database.sql -o ./out
wpress extract-file backup.wpress 'uploads/*.jpg' -o ./images
wpress extract-file backup.wpress wp-config.php --flat -o ./tmp   # ignore folders
wpress extract-file backup.wpress uploads/2022 -n                 # dry-run: show matches + size
wpress extract-file backup.wpress --from list.txt -o ./out        # extract exact paths from a file
```

### tar — stream files as a tar archive (no staging)

Transcodes matching files into a standard tar stream on stdout, so you can pipe
them straight into another tool without writing to disk.

```bash
# extract a folder via the system tar
wpress tar backup.wpress uploads --strip uploads | tar -x -C ./uploads

# push it to a server in one pipe (no local staging)
wpress tar backup.wpress uploads --strip uploads \
  | ssh user@host 'tar -x -C /var/www/html/wp-content/uploads'
```

`--strip <prefix>` removes a leading path from the tar entry names, so a
directory's **contents** land in the target dir.

### manifest — machine-readable file list

Prints `"<bytes>\t<path>"` per file (optionally under a path). Used internally
by `wpress-rsync` for size-budgeted batching, handy for your own scripts too.

```bash
wpress manifest backup.wpress uploads | sort -rn | head   # largest files
```

---

## Transfer helpers

Both move a directory out of an archive to a destination while keeping local
disk usage tiny. Pick based on what the destination allows.

### `wpress-rsync` — chunked rsync (incremental, resumable)

Builds a manifest, groups files into **size-budgeted batches**, and for each
batch: extract → rsync → delete → next. Peak local disk ≈ one batch, no matter
how big the directory is. Works for local paths and any rsync target.

```
wpress-rsync <archive.wpress> <archive-dir> <destination> [opts] [-- rsync-opts...]
```

| Option | Meaning |
|---|---|
| `-b, --budget SIZE` | Max bytes staged per batch (default `300M`). |
| `-M, --max-file SIZE` | Skip any file larger than SIZE; log them (see below). |
| `-s, --staging DIR` | Where to stage batches (default: temp dir in CWD). |
| `-k, --keep` | Keep the staging dir afterwards. |
| `-n, --dry-run` | Show the plan, transfer nothing. |
| `RSYNC_BASE` env | Override base rsync flags (default `-a`, e.g. `RSYNC_BASE='-rlvz'`). |

The destination's **contents** semantics: the archive directory's contents are
synced **into** `<destination>`.

```bash
# local
wpress-rsync backup.wpress uploads ./local-uploads

# preview the batch plan
wpress-rsync backup.wpress uploads ./local-uploads -n
```

> `--delete` is not allowed — with batched syncing it would wipe files sent in
> earlier batches.

### Skipping large files

Hosts often choke on huge media. `-M/--max-file` skips files above a threshold
and writes a record to **`wpress-skipped-<dir>.tsv`** so the list survives
scrollback. The run prints a copy-paste command to extract just those files
later:

```bash
wpress-rsync backup.wpress uploads user@host:dest/ -M 100M -- ...

# ...later, pull the skipped ones locally to handle separately:
wpress extract-file backup.wpress --from <(cut -f2 wpress-skipped-uploads.tsv) -o ./big-files
```

### `wpress-ssh` — tar-over-ssh (zero staging)

Pipes `wpress tar | (gzip?) | ssh host 'tar -x -C dest'`. Nothing touches local
disk. Requires that the server allows **remote command execution** over SSH.

```
wpress-ssh <archive.wpress> <archive-dir> <[user@]host:/dest> [-z] [-- ssh-opts...]
```

```bash
wpress-ssh backup.wpress uploads user@host:/var/www/html/wp-content/uploads
wpress-ssh backup.wpress uploads user@host:/srv/uploads -z -- -p 2222 -i ~/.ssh/key
```

---

## Pantheon notes

Pantheon's SSH gateway is locked to **SFTP/rsync only — no shell exec**, so
`wpress-ssh` (tar-over-ssh) does **not** work there. Use `wpress-rsync`:

- Target path must be **relative** (`files/`, not `/files`). On a WP site,
  `files/` is `wp-content/uploads`.
- The environment must be in **SFTP** connection mode (not Git).
- Pantheon may reject very large files; use `-M` to skip them and upload those
  few separately (SFTP GUI / media offload).
- Reuse one SSH connection across batches with a short control path (`%C`), and
  add resilience flags:

```bash
A=backup.wpress
H=dev.UUID@appserver.dev.UUID.drush.in

wpress-rsync "$A" uploads "$H:files/" -b 300M -M 100M \
  -- -e 'ssh -p 2222 -i ~/.ssh/id_rsa -o ControlMaster=auto -o ControlPath=~/.ssh/cm-%C -o ControlPersist=120' \
     --size-only --ipv4 --copy-unsafe-links --partial --inplace --timeout=0
```

---

## The `.wpress` format (brief)

A flat sequence of `[header][file bytes] … [footer]`. Each header is **4377
bytes**:

| Offset | Size | Field |
|---|---|---|
| 0 | 255 | filename (null-terminated) |
| 255 | 14 | file size (ASCII decimal) |
| 269 | 12 | mtime (ASCII unix seconds) |
| 281 | 4096 | path prefix (null-terminated) |

The archive ends at the first block with an empty filename (All-in-One WP
Migration writes a footer block there whose size field holds the total archive
size). It is not tar-compatible — which is why `wpress tar` transcodes on the
fly.

---

## Publishing to npm

This repo is set up to publish as an npm package (`bin` entries make the three
commands global on install).

1. **Pick a name.** Edit `name` in `package.json`. If `wpress-toolkit` is taken,
   scope it to your account/org, e.g. `@your-scope/wpress-toolkit`.
2. **Set repo/author/license** fields in `package.json` to match your project.
3. **Log in** to npm: `npm login`.
4. **Preview** exactly what will be published (uses the `files` whitelist):
   ```bash
   npm pack --dry-run
   ```
5. **Publish:**
   ```bash
   npm publish              # unscoped, or scoped+private
   npm publish --access public   # for a public scoped (@scope/...) package
   ```
6. **Release new versions** with semver bumps:
   ```bash
   npm version patch    # or minor / major  (commits + tags)
   npm publish
   ```

Only the files in the `files` array (`wpress.js`, the two `.sh` helpers,
`README.md`, `LICENSE`) are published — test artifacts and `node_modules` are
excluded.

---

## License

MIT © Sean Dietrich
