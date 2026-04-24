---
name: gitnexus-release-packaging
description: "Use when the user asks to 打包/打包更新/发布新版本/build offline image/cut a release. Builds Dockerfile.cli + Dockerfile.web, docker saves them into a gzipped tar, and publishes a GitHub Release on the `fork` remote (caork/GitNexus) with the tar as an asset. Triggers: \"打包更新\", \"打包发布\", \"release 打包\", \"build release\", \"cut a release\", \"打个离线包\"."
---

# GitNexus Release Packaging

Build offline-runnable Docker image bundle and publish to GitHub Releases on the `fork` remote.

## Invariants (read first)

- **Push target is always `fork` (caork/GitNexus)**, per [CLAUDE.md](../../../../CLAUDE.md) fork policy. Never push tags or releases to `origin` (upstream).
- **Architecture matters.** The image tar only runs on the same CPU arch it was built on. If maintainer laptop is `arm64` but deployment target is `x86_64`, either build on an `x86_64` host OR use `docker buildx build --platform linux/amd64 --load`. Always encode the arch into the asset filename (`gitnexus-images-<arch>.tar.gz`).
- **Source of truth for version** is `gitnexus/package.json`. Don't invent a tag — read the `version` field and prefix with `v`.

## Steps

### 1. Preflight

```bash
# Confirm remotes, version, docker daemon, gh auth
git remote -v | grep fork || { echo "fork remote missing"; exit 1; }
VERSION=$(node -p "require('./gitnexus/package.json').version")
TAG="v$VERSION"
ARCH=$(uname -m)
echo "Releasing $TAG ($ARCH)"

# gh auth must be active for caork account
gh auth status 2>&1 | grep -q 'caork' || { echo "gh not logged in as caork"; exit 1; }

# Docker daemon up?
docker info >/dev/null 2>&1 || colima start --cpu 4 --memory 8 --disk 40
```

If `gh release view "$TAG" --repo caork/GitNexus` already exists, ask the user whether to bump the version first (edit `gitnexus/package.json`) or overwrite (`--clobber` on upload).

### 2. Build images

```bash
docker build -f Dockerfile.cli -t "gitnexus:$VERSION" -t gitnexus:offline .
docker build -f Dockerfile.web -t "gitnexus-web:$VERSION" -t gitnexus-web:offline .
```

First build is slow (native modules: tree-sitter-*, onnxruntime-node). Subsequent runs use the Docker layer cache.

### 3. Save + compress

```bash
ASSET="gitnexus-images-${ARCH}.tar.gz"
docker save "gitnexus:$VERSION" "gitnexus-web:$VERSION" | gzip > "$ASSET"
ls -lh "$ASSET"   # expect 600MB–1GB
```

### 4. Tag and push to `fork`

```bash
git tag "$TAG"
git push fork "$TAG"     # NEVER `git push origin` — upstream policy
```

If the working tree is dirty, stop and ask the user — don't silently tag uncommitted work.

### 5. Publish the Release

```bash
gh release create "$TAG" "$ASSET" \
  --repo caork/GitNexus \
  --title "GitNexus $TAG (Linux $ARCH)" \
  --notes "$(cat <<EOF
## Offline Docker image bundle

Pre-built \`gitnexus\` + \`gitnexus-web\` images for Linux **$ARCH**. See [LOCAL_REMOTE_USE.md § 方式 B](../blob/main/LOCAL_REMOTE_USE.md) for deployment.

\`\`\`bash
gunzip -c $ASSET | docker load
SERVER_IMAGE=gitnexus:offline WEB_IMAGE=gitnexus-web:offline \\
  WORKSPACE_DIR=\$HOME/code docker compose up -d
\`\`\`

Built from commit \`$(git rev-parse --short HEAD)\`.
EOF
)"
```

If the tag already has a release and the user confirmed overwrite:

```bash
gh release upload "$TAG" "$ASSET" --repo caork/GitNexus --clobber
```

### 6. Verify

```bash
gh release view "$TAG" --repo caork/GitNexus
```

Report the release URL back to the user.

## Multi-arch (optional)

If the team needs both `arm64` and `amd64` bundles, run step 2 twice with `--platform`:

```bash
docker buildx build --platform linux/amd64 -f Dockerfile.cli -t gitnexus:$VERSION-amd64 --load .
docker save gitnexus:$VERSION-amd64 | gzip > gitnexus-images-x86_64.tar.gz
```

Upload both tars as separate assets to the same release.

## Do NOT

- Do NOT `git push origin <tag>` — that targets upstream `abhigyanpatwari/GitNexus`.
- Do NOT publish a release from a dirty working tree without user confirmation.
- Do NOT skip the arch suffix on the asset filename — an amd64 user downloading an arm64 tar gets a cryptic `exec format error` at runtime.
- Do NOT bump `gitnexus/package.json` version unilaterally; ask the user first.
