# Hub 与 Android 浏览器联合验收

2026-10-21，使用独立本地 Hub 页面和专用 Android 15 模拟器。没有修改或部署 Hub、Web、Android 产品源码，没有登录真实账号或读取生产数据。账号登录、AI 额度与云同步继续保持暂不接入。

## 结果

- Hub 提交 `11628b2d39fd715e0cf5d1742b0a7acd479b522e`，分支 `feat/hub-android-import-entry`。`app.js`、`local-import.js`、`styles.css` 与主目录当前副本字节一致；指定协议/网页测试 **16/16 通过，0 跳过**，两项语法检查通过。
- 从该提交导入 `createApp`，使用全新临时数据目录、合成作者与已审核公开包记录，禁用邮件、管理和云端运行时。页面使用真实前端，Android 下载器仍固定访问官方 HTTPS Hub，未改其来源限制。
- 桌面与 393 像素窄屏的三个下载入口顺序正确，说明可见，没有横向溢出。实际匿名浏览器文件下载为 2,065,181 字节，SHA-256 与公开包清单一致。
- **实际 Android Chrome 点击**：“下载并导入到本地”从未运行状态唤起已安装安卓版，并自动打开「1997 年考研英语真题」。没有使用 ADB `ACTION_VIEW` 代替本次浏览器点击。此模拟器只有一个 scheme 处理程序，直接打开 App，没有出现选择器或打开确认框。
- 返回 Chrome 再次点击，客户端进程保持 PID `3985`，打开相同题库，没有新副本。
- 强停测试 App、开启飞行模式并关闭 Wi-Fi，再从原浏览器页面点击，App 以新 PID `4458` 启动，已下载题库仍可显示。最终视口 1280×744，无题型错误和横向溢出。
- 三次流程之后均为 **50 本题库**；目录、每本源内容及完整作答/历史摘要与验收前逐项一致。没有清理题库、回执或作答来制造新下载。

APK 未变化，仍是 `0.1.0-feature-preview`，SHA-256：`2d3fdf4d79406b2c20bc230699e8674c960008eacd3585648d7f33109ed4c4ae`。

## 范围与后续

此次浏览器点击命中已有导入回执，证明了网页入口、系统唤起、版本去重和离线打开；没有重新执行原生网络下载。此前相同 APK 已经由原生 `ACTION_VIEW` 真正下载公开包并导入 47 本题库，记录保留在 `hub-import-flow.json`，两种证据分别说明，不互相替代。

仍需验证从浏览器发起的全新下载进度、取消与错误；未安装 App 的 Android 后备操作、其他浏览器与系统提示、实体手机/平板及正式签名发布包。云端按钮仅检查显示，测试页的 `practice.example` 是占位目标，没有点击或登录。

初次启动出现 System UI、桌面和 Chrome ANR，日志显示明显调度压力；当时宿主可用内存不足。用户释放内存后，专用 AVD 使用 1280×800 实际显示、2 GiB/4 核和 host GPU，完成上述流程。保留失败日志，不能据此宣称真实设备稳定性已通过。没有关闭用户其它应用、清空 Chrome 或卸载 QuizForge。

自动审批曾拒绝 secondary-user 启用应用和命令行打开浏览器的批次，只返回 `blocked by policy`。未继续该方案；临时空用户已随模拟器关闭消失。实际浏览器操作改用 computer-use 图形界面，Chrome 首次使用经用户确认选择不登录账号。

## 证据

完整索引：[joint-acceptance.json](../output/acceptance/hub-joint-20261021/joint-acceptance.json)。其中记录 APK 与 Hub 来源摘要、原生状态核对及截图摘要。`verification.json` 和 `node-tests-16.log` 保留 Hub 侧检查；`primary-before.json`、`browser-cold-after.json`、`browser-warm-after.json`、`browser-offline-cold-after.json` 保留四个状态快照。

![Android Chrome 中的新版 Hub 入口](../output/acceptance/hub-joint-20261021/android-hub-before-click.jpg)

![实际浏览器唤起后离线显示题库](../output/acceptance/hub-joint-20261021/android-browser-offline-opened.jpg)
