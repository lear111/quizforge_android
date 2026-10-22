# Android AI 评分边界与联调

本模块复用现有 Web 的设置页、题卡 AI 消息和任务 REST 语义，不上传题库或答题记录到 Hub。只有用户测试模型、点击 AI 评分或启用自动评分后，原生网络层才向选中的评分来源发送评分材料。

2026-10-22 起，评分来源与 Web 一致，分为“使用免费 AI 额度”（Hub 账号登录，协议 v1 §7.2）和“使用自定义模型”，两者可以同时开启，优先使用免费额度。登录、令牌保存、错误映射与回退规则见 `docs/HUB_AI_2026-10-22.md`。

## 原生接口

`AiGateway(Context, ResourceResolver)` 接收本地图片读取器，`ResourceResolver.read(bankId, assetId)` 返回 `{mime,data}`；`data` 是 Base64，本地资源 ID 必须是 SHA-256。建议桥接：

| Native method | args | Gateway |
| --- | --- | --- |
| `settings.ai.get` | `{}` | `status()` |
| `settings.ai.update` | `{profile:{...}}` | `update(profile)` |
| `settings.ai.test` | `{}` | `testConnection()` |
| `hub.connection.login` / `account` / `redeem` / `logout` | `{}` / `{}` / `{code}` / `{}` | `HubConnection` |
| `hub.browse` | `{url}` | 只接受固定 Hub origin，用 Custom Tabs 打开 |
| `ai.request` | `{bankId,input,configurationVersion?,repair?,invalidOutput?}` | `generate(args)` |

模型测试与生成请求使用独立网络 executor，不能占用本地保存队列。`close()` 取消此 gateway 的未完成请求。没有真实密钥读取接口；配置以 Keystore 生成的 AES-256-GCM 密钥加密后写入私有 AtomicFile，解密/密钥损坏时保留原文件并报错。Android Keystore 保护的是加密密钥，解密后的 API Key 在原生进程调用期间仍会存在于内存，不宣称抵御已控制应用进程的攻击者。

当前仅支持 HTTPS OpenAI-compatible `/chat/completions`。采用系统 TLS/主机名校验，保留系统网络代理；专用 client 不共享 Cookie、源站/代理认证、Hub 会话、重定向或自动网络重试。HTTP 私网模型是相对 Web 的明确差异，界面会提示使用 HTTPS，本轮没有放宽 cleartext 配置。更换服务地址需重新填写该服务的 Key 或清除旧 Key，隐藏占位值不能把旧密钥送往新地址。排队任务保存不含秘密的 `configurationVersion`，配置变化后未发出的请求会停止并要求显式重试。

## Web 适配

```js
const ai=createAiService(nativeCall);
const practice=createPracticeService(nativeCall,{loadText,examEnabled:true,aiService:ai});
// ai 必须在通用 settings/practice 服务之前处理对应 REST。
installOfflineFetch({services:[ai,library,exam,practice]});
```

`/api/settings/ai/credential` 只生成固定非秘密占位值，实际密钥始终留在原生层。旧设置页保存该占位值时 adapter 剥离此字段以保留密钥；删除占位值按旧页协议清除，填写新值则替换。没有“显示真实密钥”能力。不得把占位值当作真实密钥或发送给模型。

`ai-service.js` 持久保存 `ai-task` 文档，任务包含固定评分输入、题库/题目/轮次/拓展和答案快照、提交/评分代次、模型建议及确认结果。普通客户端不能传任意 endpoint、Key、图片 URL、题库原始答案或可信 AI 标记。评分输入仅由题型 `prepareAiGrading` 生成；结果仍通过题型 `review`，同一次原子提交更新答案状态、历史和请求回执。人工评分、重答、内容修改或新轮次会使旧结果失效；白板变更不会误使任务失效；小问任务只跟踪对应小问代次。

任务状态为 `queued/running/succeeded/confirmed/failed/superseded`。网络失败不自动重新收费；用户可以显式重试。无效模型 JSON 最多增加一次格式修复请求，总计至多两次。成功建议按现有 Web 行为自动保存，原确认接口仍支持幂等读取，改分需走人工评分。应用中断后的未完成任务会标记失败，不在重开时自动请求模型。未开启历史保存的题库只保留内存任务。任务缓存、临时任务与网络排队均有边界。

多模式宿主可用 `bindScope(kind,{context,payload,bindTask,applyAiReview})` 接入，但考试必须提供自己的固定题目、轮次状态和资源映射，不能拿当前题库作答冒充考试答案；未接入模式明确拒绝 AI 入口。当前预览版的 AI 评分用于普通练习；考试 AI 尚未接入，考试使用客观判分与人工评分。

## 验证证据与仍需验证

- Node 测试使用虚构模型，覆盖密钥占位适配、任务回执/重启、中断不自动收费、旧结果隔离、白板并发、多小问隔离、一次修复与临时任务不落盘。
- `AiGatewayTest` 使用拦截器返回虚构响应，验证 Keystore 加密、Key 不回传、地址限制、内容边界、错误脱敏与随机图片能力测试不冒报通过。
- 本轮没有调用真实付费服务。真实文字/图像模型兼容性、费用、服务器 CORS 与供应商账户等不能由 mock 测试替代；原生调用不依赖浏览器 CORS。
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)、[Android 密码学建议](https://developer.android.com/privacy-and-security/cryptography)、[Android 网络连接](https://developer.android.com/develop/connectivity/network-ops/connecting) 是本轮核对的官方资料。
