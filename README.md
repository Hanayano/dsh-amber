# dsh-amber

保护你选中的核心对话（seq 区间）永不进压缩——原文和思考过程一起留在上下文里。

## 它是什么

本插件用于在长上下文中，挑选并保护最核心的思考过程与对话经历。防止它们在 Compaction（上下文压缩）中被遗忘或抹去。

## 安装

```bash
dsh plugin --profile <profile-name> add https://github.com/Hanayano/dsh-amber
```

装完按 DSH 的提示重启（或重载）一次，让新引擎接管压缩管线。

## 使用

1. 打开 DSH → 设置 → **压缩保护**
2. 勾选要启用保护的会话
3. 点「挑核心对话」，勾选要保护的消息
4. 点「加入核心区」

界面里的改动（勾会话、加/删核心区）走实时路由，**即时生效**，无需重启。

## 配置

核心区清单默认存到 `~/.dsh/amber.json`，可用环境变量覆盖到任意路径：

```bash
# 可选：把核心区清单放到别处
DSH_AMBER_FILE=/path/to/amber.json
```

压缩相关的默认值在 `cordis.patch.yml` 里，可自行调整（改后需重启才生效）：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `thresholdRatio` | `0.95` | 上下文占用达到窗口多大比例时触发压缩 |
| `retainTokens` | `32000` | 压缩后保留在上下文里的 token 数 |
| `headroomTokens` | `65536` | 为补全预留的 headroom token 数 |

## 两个局限（请先读完再装）

1. **它替换 `compaction-basic`，与其他压缩引擎互斥。**
   本插件通过 `disabled: true` 关掉 DSH 原版压缩，并接管 `ctx.compaction`。如果你已经在用别的压缩引擎（例如 `billion-context`、`dsh-live-compact`），两者会争抢同一条压缩管线、互相打架。装之前请先卸载另一个：

   ```bash
   dsh plugin --profile <profile-name> remove <other-compaction-plugin>
   ```

2. **核心区靠 seq 区间定位，seq 是会话内部的。**
   保护的是「当前这个会话文件里的 seq 区间」。当会话被 fork、轮换，或导出/导入到新会话后，seq 会重新编号，旧的核心区不会自动延续到新会话——你需要在新会话里重新挑一次核心对话。

## License

[MIT](./LICENSE)

## 琥珀

透明的外壳中包裹着一只栩栩如生的的死物
