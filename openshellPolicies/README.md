# OpenShell policies for pidev

Everything that controls what Pi may do inside OpenShell.

| File | What it controls | How it is loaded |
|---|---|---|
| `policy.yaml` | Sandbox policy: filesystem (Landlock; rw only `/sandbox/project`, `/sandbox/pi-agent`, `/tmp`) and network (web + memory containers, PyPI, npm, GitHub read), each rule limited to specific binaries | `bin/pidev` passes it via `--policy` on every start → edit and start a new `pidev` |
| `pi-spark.yaml.template` | Provider profile: inference on the LLM endpoint only (`PIDEV_LLM_HOST:PIDEV_LLM_PORT` from `.env`) | `bin/pidev` renders it to `.generated/pi-spark.yaml`, imports it on first run, updates it when `.env` changes and creates the `pi-spark` provider |
| `pi-github.yaml` | Provider profile: git clone/fetch/push to github.com; `GITHUB_TOKEN` is only a placeholder inside the sandbox | `openshell provider profile import -f pi-github.yaml` + `openshell provider create --name pi-github --type pi-github --credential GITHUB_TOKEN` |
| `pi-gitlab.yaml` | Same for gitlab.com (`GITLAB_TOKEN`) | same as above with `pi-gitlab` / `GITLAB_TOKEN` |
| `gateway.toml` | Gateway: allows driver config and bind mounts | **Reference copy.** Active file is `~/.config/openshell/gateway.toml`, referenced by `~/.config/openshell/gateway.env` (`OPENSHELL_GATEWAY_CONFIG=…`) → `brew services restart nvidia/openshell/openshell` |

Notes

- `bin/pidev` attaches the providers `pi-spark`, and `pi-github` / `pi-gitlab` if they exist; their endpoints are added to the policy automatically.
- After editing a provider profile: re-import it (`openshell provider profile import -f …`).
- Which Mac folders are mounted is not a policy, it's set in `bin/pidev` (`--driver-config-json`).
- See blocked requests live: `openshell term`.
