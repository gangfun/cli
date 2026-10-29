# gangfun/cli：给 agent 的协作须知

## 这是公开仓库，也是公开的 npm 包

`gangfun/cli` 是 **public** 仓库。凡是推到 GitHub 的内容，任何人都能看到，而且删不干净（fork、缓存、镜像、通知邮件都会留着），包括：

- commit 和分支名；
- PR 标题、描述和评论、review，以及 issue；
- 仓库里的所有文件。

`src/`、`README.md`、`README.zh-CN.md` 还会作为 `@gangfun/cli` 发到 npm：

- 每个版本都永久公开；
- 撤回受限，同一个版本号也不能再用。

所以 commit、push、开 PR、写评论之前，先确认里面**没有**下面这些：

- **密钥类**：私钥、助记词、API key（BscScan / Etherscan 等）、带 token 的 RPC 地址（QuickNode 之类）、`.env` 的内容、Telegram / 告警 bot token。代码里的默认 RPC 只能用公共节点；私有节点让用户通过环境变量或参数传入。
- **运维内部信息**：服务器 IP 和主机名、服务器上的路径、cron 配置、keeper 的私有发送通道、告警渠道、多签签名人、钱包和人的对应关系。
- **主网上还没修好的漏洞**：攻击步骤、受影响的合约或代币清单、能拿多少钱的估算，一律不写进代码注释、报错文案、README、commit 或 PR。要先修好上线，或者确认没人能借此获利，再公开。
- **个人信息**：邮箱、真名、聊天记录、dev 或用户的联系方式。
- **私有仓库的内部细节**：gangfun-server、gang-web-legacy 的实现、配置和运维细节。

## 做法

- **源码在 gang-launchpad。** CLI 的源码在 `gangfun/gang-launchpad` 的 `skill/gang-cli/`（那个仓库也是 public，根目录 `CLAUDE.md` 有同样的规矩）。这里的改动要从那边同步过来，不要只改这里。
- **push 前先过一遍。** 看一遍 `git show --stat` 和完整 diff；PR 描述发出前从头读一遍。
- **发版前确认 npm 包内容。** 发版（提升 `package.json` 版本号）前，用 `npm pack --dry-run` 看清会进 npm 包的文件和内容。合到 `main` 后 CI 会自动发布；只改文档、没提升版本号的 push 不会发布。
- **拿不准先问。** 拿不准的，先问用户再发。不要先发、有问题再删：删掉之前就已经有人看到或缓存了。
- **泄露了马上报告。** 发现已经泄露：马上告诉用户。密钥让用户轮换；不要自己改写已经推送的历史，也不要自己撤回 npm 版本。
