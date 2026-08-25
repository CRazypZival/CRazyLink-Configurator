# CRazyLink Configurator

CRazyLink 的静态 Web 上位机。页面通过 WebUSB 连接 TX/RX 的原生 USB 功能接口，提供远程 SWD 烧录和目标 UART 监视。

## 本地使用

```bash
cd web
npm test
npm run build:single
open dist/index.html
```

`dist/index.html` 是内联 CSS、协议代码、WebUSB 代码和图标的单文件构建产物，可以作为离线版本分发。推荐使用 Chrome 或 Edge。

## GitHub Pages

推送 `master` 分支后，GitHub Actions 会构建并发布 `web/dist`。在仓库设置中选择 `Settings -> Pages -> Source: GitHub Actions`，部署完成后即可通过 Pages 地址使用。

WebUSB 需要用户在浏览器中点击“连接设备”并授权。网页不能访问远程电脑上的 USB；每位用户都需要将自己的 CRazyLink TX 接到自己的电脑。

