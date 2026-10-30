export function helpText(): string {
  return `memrelay — 跨 AI coding 工具的任务接力 / cross-agent task relay

用法 / Usage:
  memrelay resume [关键词|<会话 id>] [--out <文件>]
      agent 用。在当前项目里找出被中断的任务，打印续接内容；
      关键词缺省时接最近一个中断的任务；给 agent:id 时强制选中该会话
      （从候选菜单选定后用，能落链）。输出首行固定为【MemRelay 续接】。
  memrelay show <会话 id> [--from N]
      agent 用。分页查看某个会话的原始记录，如 memrelay show qoder:3f2a… --from 120。
  memrelay search <关键词> [--limit N]
      agent 用。在当前项目的会话里搜索（中文按两字词切分，也支持英文与路径）。
      菜单里没有合适的任务时，换关键词再搜一轮；拿到会话 id 后用 show 看细节。
  memrelay hint
      hook 用。输出一行未完成任务提示（没有则什么都不输出）。
  memrelay hook [--flavor <工具>]
      hook 用。从 stdin 读宿主事件的 JSON：Stop / SessionEnd 时按 transcript_path
      增量索引那一个会话文件；SessionStart 时补扫变更过的文件并输出上面的提示。
      --flavor trae-cn 把钩子事件落成 relay-events（Trae IDE 会话库加密）；
      --flavor opencode / zcode 按 payload 里的 session_id 精准索引那一次会话（库可读）。
      静默、幂等、永不阻塞宿主，出错一律静默退出 0。
  memrelay setup [--undo] [--purge] [--skip <工具>]... [--no-enhance]
      用户用。检测本机装有的工具，列出勾选清单（默认全选，空格取消，勾选即确认），
      然后写入 Skill、触发增强（启动提示 / 实时索引 / 事件采集）并建立会话索引。
      --skip claude-code 可在非交互场景跳过指定工具；--no-enhance 跳过触发增强；
      --undo 撤销全部（各工具的 settings.json 为外科手术式移除条目，其它配置不动）。
  memrelay doctor
      用户用。自检：会话解析与索引、中文输出是否正常、Node 与启动脚本是否可用；
      语义检索（向量）开启时顺带补齐回填并报告状态。
  memrelay embed [--status]
      用户用。向量回填：把 user/assistant 正文（已密钥脱敏）嵌入并落库，
      未变化的块零 API 成本跳过；--status 只打印状态（已嵌 / 待嵌 / 指纹 / 最近错误）。
      开关与配置在 memrelay ui 的配置页；opt-in，默认关。
  memrelay summarize [--status]
      用户用。会话摘要生成：用配置页填写的摘要接口与对话模型把会话尾部压成
      2~4 句进展摘要（接力、任务列表、会话浏览里展示）；素材未变零 API 成本跳过。
      --status 只打印状态。开关与接口都在配置页；opt-in，默认关。
  memrelay tidy [--status|--apply|--undo]
      用户用。跨工具偏好整理：只读导入各工具的全局记忆/规则，调整理接口合并后，
      写回四家工具（Qoder / Codex / Trae CN / Claude Code）的 MemRelay 标记块；
      自动模式在 memrelay ui 运行期间按来源指纹变化触发。--undo 撤销下发。
  memrelay ui [--port N]
      用户用。打开本地管理界面；运行期间后台自动回填向量（开启时）。
      默认固定端口 4823（被占用时随机），固定端口让主题/语言偏好跨启动沿用。
  memrelay ping
      打印固定标记和版本号，用于 setup 自测。

约定 / Conventions:
  - 输出一律为 UTF-8，无 BOM。首行乱码时改用 --out <文件> 再读文件。
  - 退出码：0 成功（含候选菜单）；1 用法错误；2 环境错误。
  - resume / show 只读文件、只打印，不访问网络和本地端口。

示例 / Examples:
  memrelay resume "生成前端网站"
  memrelay resume
  memrelay show qoder:4469e21c --from 0
`;
}
