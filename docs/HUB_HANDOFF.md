# Hub → Android 一键下载交接

本轮只修改 `quizforge_android`。不要在此任务中修改或部署 `quizforge_hub`、`quizforge_web`，不要读取 `.env`、运行数据或登录凭据。下文用于另一个负责 Hub 的对话。Android 原生接收、下载、导入与重复链接已在独立 Android 15 模拟器验证：经 `ACTION_VIEW` 实际下载公开包，47 本题库成功导入；暖启动重复链接、飞行模式冷启动重复链接均没有创建副本。实际浏览器点击、首次系统唤起提示及真实设备仍需联合验收，不能用 ADB 解析代替这些步骤。

2026-10-21 补充：Hub 入口更新后，独立本地页面已通过模拟器内真实 Chrome 点击，完成冷/热启动及飞行模式冷启动，均打开已有题库且没有副本，原 50 本题库内容与作答/历史摘要保持一致。该浏览器测试命中旧回执，未重做原生网络下载；此设备直接唤起 App，没有出现选择框。详见 [联合验收记录](HUB_JOINT_VALIDATION.md)，下方协议与后续真机验收边界保持有效。

## 已有协议与 Android 对接

官方源已从 `quizforge_hub/README.md`、Hub v1 设计协议和 Windows `HubPackageImport.cs` 交叉确认：

```text
https://quizforge.treenewbee.cloud
quizforge://hub/import?v=1&pack=<小写 UUID>&revision=<正整数>
```

网页链接只包含协议版本、题库 ID 和 Hub revision。不要增加任意 URL、回调、Cookie、用户 ID、文件路径、命令参数或 API Key。现有 `public/local-import.js` 已生成该链接，且保留文件下载按钮。新原生入口不能沿用只接受 `content://` 的本地文件打开分支。

客户端依次匿名 GET：

1. `/api/packs/<id>/local-import?revision=<n>`：最多 32 KiB 的 JSON，校验 `schemaVersion:1`、ID、revision、`.qbank` 附件名称、1–67108864 字节大小和小写 SHA-256。
2. `/api/packs/<id>/download?revision=<n>&sha256=<摘要>`：必须是 200、`application/octet-stream`、单一且精确的 Content-Length，无 Content-Encoding。流式下载到应用私有缓存中的随机任务目录，匹配实际字节数和 SHA-256 后才进入现有事务导入器。

原生类：`HubImportClient`。在导入队列调用：

```java
HubImportClient.ImportRequest request = HubImportClient.parse(uri);
try (HubImportClient.DownloadedPackage archive = client.download(request, cancellation, progress);
     InputStream input = archive.openStream()) {
    JSONObject result = repository.importPackage(input, null);
    // 只在这里成功后更新题库列表、选中新题库并报告成功。
}
```

`displayName`、`title` 只用于界面，不用于暂存路径或安装名称。传 `null` 给仓库的 filename 参数，使包内清单决定题库名称。下载成功不等于导入成功；非法包、旧包格式、需要 API 1.5 / answer-areas 等能力的拓展仍由现有仓库校验拒绝，不能因此放宽兼容边界。取消、断网、长度/摘要不符或导入失败，不改动旧题库、答案或历史。

两次请求共用 180 秒网络期限，不自动重试、不跟随重定向，不发送浏览器 Cookie、Hub 会话、源站认证或代理认证凭据。采用独立 OkHttp client 和系统 TLS 校验；保留 Android 系统 ProxySelector，使用户设置的 Wi-Fi 代理仍可工作。此点有意区别于 Windows 下载器的禁代理设置，不能把代理地址/凭据从网页或深链传给客户端。VPN 路由仍由 Android 管理。

`ProgressListener` 在工作线程回调 `(stage, receivedBytes, totalBytes, displayName)`，stage 为 `manifest`、`download`、`verified`。原生界面需要切回主线程显示进度。持有 `CancellationSignal`，用户取消/页面销毁时取消当前网络任务；应用进程被终止后的暂存缓存不视作已导入的内容。

## 给 Hub 对话的工作指令

> 请仅在 quizforge_hub 完善 Android 的一键导入入口，不修改 Android 或 Web 主项目，沿用现有匿名公开导入 v1 协议和权限边界。三个按钮统一为“下载题库文件”“下载并导入到本地”“下载并导入到云端”。本地按钮继续使用 `quizforge://hub/import?v=1&pack=<id>&revision=<n>`，电脑和安卓共用一个入口，由当前设备系统唤起已安装客户端，用户无需选择平台。本地说明为“导入当前设备上的 QuizForge，支持电脑和安卓手机、平板。”云端说明为“导入账号的云端题库，需登录。”只为已审核公开 `.qbank` 提供直接导入。点击后只说明“已请求打开 QuizForge，请在系统提示中允许打开”，不要声称下载或导入已成功。不要通过计时器、隐藏 iframe、循环尝试、localhost 探测或跨站回调判断安装/导入结果。安装入口明确区分 Android 与 Windows，Android 发布链接和正式签名确定后再配置，不猜地址。保留普通文件下载作为未安装或浏览器未唤起时的后备，公开下载不增加登录门槛，不做云端答题同步。提交可审阅修改并跑现有协议/网页测试；本任务未授权部署。

## 原生账号登录的后续配合

当前 APK 的“账户与题库广场”在系统浏览器管理 Hub 会话。App 不读取浏览器 Cookie，也不把 Web 本机主机密码框用于 Hub 登录。

若后续要让 App 显示真实 Hub 登录身份，请 Hub 对话先提供可审阅的移动授权接口方案：在官方 HTTPS 页面登录后，仅返回短时、一次性授权码，绑定随机 state 与 PKCE 校验；通过受限回跳交给 App，再由原生兑换账号会话。深链不携带密码、长期令牌或浏览器 Cookie。接口应定义当前账号查询、过期续期、退出/撤销、错误和设备会话边界。现有网站 SSO 的固定 origin 检查不得为兼容 appassets 而全局放宽。保留离线功能免登录，账号授权不等于上传题库、答案或开启同步。Android 与 Hub 约定实际接口后再接客户端，当前未宣称原生登录已完成。

如未来希望直接用 HTTPS 唤起 Android，可另行设计 verified App Links，并为正式包名/签名证书提供 `/.well-known/assetlinks.json`；当前自定义 scheme 不需要该文件，也不能声称已经获得域名验证。不能在调试签名尚会变化时抢占网站所有 HTTPS 链接。

## 仍需验收

- 未启动/已启动时由浏览器点击链接，应用正确打开并且只入队一次。
- 用户允许系统打开应用后，进度、取消和错误反馈可见；未安装时后备文件下载仍可用。
- 服务端版本变化/下架、重定向、超限、截断、摘要不符、离线与不兼容拓展均不产生半导入题库。
- 成功后选中新题库，旧题库/作答/历史保持，已下载题库断网仍能练习。
- 应用内题库广场入口可使用同一匿名下载器，但不是给题型 iframe 开放任意网络或原生下载接口。

## 本轮核对的官方资料

- [Android deep links](https://developer.android.com/training/app-links/create-deeplinks)：独立 `VIEW`、`DEFAULT`、`BROWSABLE` intent filter；多个应用可注册同一 scheme，系统可能显示选择框。
- [Android deep-link validation](https://developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks)：必须在原生入口校验所有参数，不能仅相信 Manifest 匹配。
- [Android network operations](https://developer.android.com/develop/connectivity/network-ops/connecting)：`INTERNET` 为安装时授予的普通权限，网络操作应在工作线程并使用 TLS。
- [OkHttp 官方 README](https://github.com/lysine-dev/okhttp/blob/parent-5.4.0/README.md)：本轮固定 5.4.0 正式版本，支持 Android API 21+ 与 Java 8+；从 Maven Central 官方 AAR 读取的 `aar-metadata.properties` 确认 `minCompileSdk=36`，覆盖本项目 compileSdk 36/API 29/Java 17。5.5.0 的 AAR 要求 compileSdk 37，因此本轮不用它，不升级全工程 SDK/AGP。原 `square/okhttp` 已重定向到该官方仓库。
- [OkHttp recipes](https://lysine.dev/okhttp/recipes/) 与 [5.4.0 client 源码](https://github.com/lysine-dev/okhttp/blob/parent-5.4.0/okhttp/src/commonJvmAndroid/kotlin/okhttp3/OkHttpClient.kt)：使用独立客户端、流式响应、取消、Cookie/Authenticator/redirect/timeout 配置；保持默认系统证书与主机名校验。
