# pi-speed

A [pi](https://pi.dev) extension that adds per-turn output speed and time to first token (TTFT) to the footer.

在 [pi](https://pi.dev) 的底部统计行中显示**每轮输出速度**和**首 token 延时（TTFT）**。

```text
↑47k ↓6.4k R179k CH84.5% $0.023 42.3t/s 1.24s 5.8%/1.0M (auto)
```

## 安装

```bash
pi install https://github.com/hxac/pi-speed
```

卸载：

```bash
pi remove https://github.com/hxac/pi-speed
```

## 开发

```bash
git clone https://github.com/hxac/pi-speed
pi install ./pi-speed
```

## 使用

| 命令 | 作用 |
| --- | --- |
| `/speed` | 显示最近一轮和整个会话的平均数据 |
| `/speed reset` | 清空统计（`/speed clear` 同义） |


## 工作原理

监听 `turn_start`、`message_update`、`message_end` / `turn_end` 事件：

- **TTFT**：从本轮开始到首个输出流事件的时间。
- **输出速度**：从首个输出流事件到助手消息结束之间的输出 token 吞吐。
- **会话平均值**：输出速度按 `总输出 token ÷ 总生成时间` 加权，平均 TTFT 是各轮 TTFT 的算术平均。

扩展通过 `ctx.ui.setFooter()` 替换了 pi 的内置 footer，复制了内置 footer 的路径、git 分支、token、缓存命中率、费用、上下文占用和其它扩展 `setStatus()` 的显示逻辑

## License

[MIT](LICENSE) © 2026 [hxac](https://github.com/hxac)
