# pi-speed

给 pi 的底部统计行加上**每轮平均输出速度**和**输入延时（TTFT）**：

```text
↑47k ↓6.4k R179k CH84.5% $0.023 42.3t/s 1.24s 5.8%/1.0M (auto)
```

- `42.3t/s`：最近一轮的平均输出速度，按 `输出 token ÷ 生成耗时` 计算。生成耗时从**第一个 token**开始算，不包含输入延时。
- `1.24s`：最近一轮的输入延时，即从本轮开始到**第一个 token**到达的时间（time to first token）。文本、思考内容和工具调用参数的首个事件都会被视为第一个 token。

统计值在该轮助手消息结束时更新。没有完成过可测量的轮次时，这两个字段不会出现，统计行与原生样式一致。

## 安装

作为本地包安装：

```bash
pi install /path/to/pi-speed
```

或者只对当前启动生效：

```bash
pi -e /path/to/pi-speed/extensions/speed.ts
```

也可以把 `extensions/speed.ts` 复制到 `~/.pi/agent/extensions/`（需要同时保留 `src/tracker.ts`，并修改相对导入），更推荐直接安装整个目录。

安装后可用 `pi list` 确认，重启 pi 或执行 `/reload-runtime`。

## 命令

```text
/speed        显示最近一轮和整个会话的平均数据
/speed reset  清空统计
```

`/speed` 的输出示例：

```text
Speed: last 42.3 tok/s · TTFT 1.24s · 1.2k tok in 28.4s
Session: 12 turns · avg 39.1 tok/s · avg TTFT 1.05s · total 14.3k tok
```

## 说明

- 为了在原统计行中插入数据，这个扩展通过 `ctx.ui.setFooter()` 替换了 pi 的内置 footer，因此复制了内置 footer 的路径、git 分支、token、缓存命中率、费用、上下文占用和其它扩展 `setStatus()` 的显示逻辑。pi 升级后如果内置 footer 有变化，本扩展需要同步更新。
- 会话平均值按总输出 token ÷ 总生成时间加权；平均输入延时是各轮 TTFT 的算术平均。
- 速度统计只覆盖扩展加载后、且收到了完整首 token 与输出 token 用量的轮次。恢复旧会话时，历史轮次不会补算速度，但 token/费用/上下文等统计仍来自完整会话记录。
- 使用虚拟模型（virtual model）时，右侧仍会显示 `→ 实际模型`。

## 开发

```bash
npm test
```

测试只覆盖纯计时/格式化逻辑，不依赖 pi 运行时。

## License

[MIT](LICENSE)
