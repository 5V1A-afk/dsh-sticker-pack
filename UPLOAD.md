# 把 dsh-sticker-pack 放上 DSH 插件市场

市场的规则：**只收录 `awesome-dsh-plugin` 精选列表里的插件**。所以「上架」= 往那个列表
提一个 PR，加一个描述你这仓库的 YAML 文件。合并后 **1 天内**生效，别人就能在插件市场里
一键安装，或者敲一条命令装：

```
dsh plugin add 5V1A-afk/dsh-sticker-pack
```

下面三步都不需要 `git`，全部在 GitHub 网页上点。

---

## 前提：仓库要满足四条硬性要求

| 要求 | 你的现状 |
|---|---|
| `package.json` 里声明 `dsh.bundle` | ✅ 已有（`dsh.bundle.patch: ./cordis.patch.yml`） |
| 有真实可用的代码 | ✅ |
| 仓库**建满 1 天**（CI 自动查） | ⏳ 明天才够 |
| 仓库带 `dsh-plugin` topic | ❌ 见第三步 |

还有一条会被 CI 直接拒绝的：**审查只从仓库根目录、或 `packages/` / `plugins/` / `apps/`
子目录里找 `package.json`**。你现在是

```
dsh-sticker-pack/            ← 仓库根
└── dsh-sticker-pack/        ← 多出来的一层
    ├── package.json
    ├── lib/
    └── stickers/
```

多这一层，CI 会认为「这个仓库没有声明 dsh.bundle」。**所以第一步必须拍平。**

---

## 第一步：把仓库拍平

1. 打开你的仓库 `https://github.com/5V1A-afk/dsh-sticker-pack`
2. 点 **Add file** → **Upload files**
3. 把这台机器上 `dsh-sticker-pack-repo\` 里的**全部内容**拖进去：
   `lib/`、`stickers/`、`test/`、`client.js`、`cordis.patch.yml`、`package.json`、`README.md`、`UPLOAD.md`
   （拖文件夹就行，网页会把里面的文件一起带上；`stickers/` 那 18 MB 会慢一会儿）
4. 页面底部点 **Commit changes**
5. 现在根目录有文件了，再把内层那层删掉：点进 `dsh-sticker-pack/` 文件夹 →
   右上角 **...** → **Delete directory** → Commit

完成后仓库长相应该是：

```
dsh-sticker-pack/            ← 仓库根
├── package.json             ← CI 就是找它
├── cordis.patch.yml
├── client.js
├── lib/
├── stickers/
├── test/
├── README.md
└── UPLOAD.md
```

## 第二步：提 PR 登记进市场列表

1. 打开 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
2. 右上角点 **Fork**（复制一份到你账号下）
3. 在你那份副本里点 **Add file** → **Create new file**
4. 文件名框里填路径：

   ```
   data/plugins/5V1A-afk__dsh-sticker-pack.yml
   ```

5. 内容抄下面这段（原样，一个字都别改）：

   ```yaml
   url: https://github.com/5V1A-afk/dsh-sticker-pack
   name: 5V1A-afk/dsh-sticker-pack
   category: fun
   description:
     en: Adds a sticker pack to DeepSeek Harness replies. The plugin rolls the dice, the model attaches the chosen sticker at the end of its reply, and the pictures come from a remote pack.json you can host anywhere.
     zh: 给 DeepSeek Harness 的回复加上表情包。贴不贴由插件掷骰决定，模型把选中的图放到回复末尾；图库来自一个可以自己托管的远端 pack.json。
   ```

6. 底部 **Commit changes**
7. 回到你副本的首页，会出现 **Contribute** → **Open pull request** →
   点 **Create pull request**

提交后 CI 会自动检查（仓库年龄、`dsh.bundle`、代码是否真实）。不通过它会在 PR 里告诉
你哪一条没过，改完再 commit 一次就行。

## 第三步：给仓库加 topic

仓库首页右侧 **About** 那块点齿轮 → **Topics** 里加一个 `dsh-plugin` → 保存。

---

## 可选：发到 npm（不是必须，但有两个好处）

1. 市场会显示下载量；
2. 用户装的时候是**预构建**的，不用点「允许构建」。

要发的话：`package.json` 里的 `repository` 已经指向你的仓库（npm 要求这个字段能对上），
在有 npm 环境的机器上 `npm publish` 即可。不发也完全不影响收录。

---

## 以后加图 / 换图

- **加图**：图片丢进 `stickers/`，`pack.json` 的 `stickers` 数组里加一行（`id` 只能用
  字母数字和 `_ $ . -`，最长 32；`file` 是相对本文件的路径），commit 即可。
  别人的插件等缓存 TTL 到期后自动同步（默认 10 分钟，你自己的 settings.json 里设了 7 天）。
- **换图必须换文件名。** 图片一旦下载就按文件名缓存在镜像目录里，同名不会重新下载。
- `file` 也可以换成 `url`，直接指向任意 http(s) 图片地址（那样就不必把图放进仓库）。
- 现在的图偏大（单张最大 12.82 MB，10 张共 18.13 MiB），别人首次用到要下 12.8 MB。
  压到 100–300 KB/张 体验会好很多 —— 压完记得改文件名和 `pack.json` 里的 `file`。
