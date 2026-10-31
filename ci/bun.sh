set -eu
test "$(uname -m)" = x86_64
mkdir -p .ci-bun
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip -o .ci-bun/bun.zip
printf '%s  %s\n' 8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed .ci-bun/bun.zip | sha256sum --check --strict
unzip -q .ci-bun/bun.zip -d .ci-bun
ln -s bun .ci-bun/bun-linux-x64/bunx
export PATH="$PWD/.ci-bun/bun-linux-x64:$PATH"
bun --version
test "$(bun --version)" = 1.3.11
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o .ci-bun/gitleaks.tar.gz
printf '%s  %s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb .ci-bun/gitleaks.tar.gz | sha256sum --check --strict
tar -xzf .ci-bun/gitleaks.tar.gz -C .ci-bun/bun-linux-x64 gitleaks
test "$(gitleaks version)" = 8.30.1
git show --no-patch --format='tested commit=%H tree=%T parents=%P'
