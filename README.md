# CRazyLink Configurator

CRazyLink 的静态 Web 上位机。页面通过 WebUSB 连接 CRazyLink 的原生 USB 功能接口，
提供本地/远程 SWD 烧录、目标 UART 监视和统一固件升级。

## 本地使用

```bash
cd web
npm test
npm run build:single
open dist/index.html
```

`dist/index.html` 是内联 CSS、协议代码、WebUSB 代码和图标的单文件构建产物，可以作为离线版本分发。推荐使用 Chrome 或 Edge。

## GitHub Pages

https://crazypzival.github.io/CRazyLink-Configurator/
