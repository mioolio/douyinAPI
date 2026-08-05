// 深入探查 Context.instance 的 store 和 plugins，找 sendMessage 方法
(async () => {
  const out = {};

  const vmokIm = window['__VMOK_@pc-im/im:1.0.0.696__'];
  const loaderFn = await vmokIm.get('.');
  const mod = await loaderFn();
  const ctx = mod.Context;
  const instance = ctx.instance;

  if (!instance) {
    out.error = 'no Context.instance';
    return out;
  }

  // 1. 查 store（mobx 单例，含所有 store）
  if (instance.store) {
    const store = instance.store;
    out.storeKeys = Object.keys(store).slice(0, 50);

    // 列出 store 的所有子 store 及其方法
    const storeDetails = {};
    for (const k of Object.keys(store)) {
      try {
        const v = store[k];
        if (v && typeof v === 'object') {
          const d = {
            type: typeof v,
            keys: Object.keys(v).slice(0, 30),
          };
          // 看 prototype 方法
          const proto = Object.getPrototypeOf(v);
          if (proto && proto !== Object.prototype) {
            const methods = Object.getOwnPropertyNames(proto).filter(
              (n) => n !== 'constructor' && typeof v[n] === 'function',
            );
            if (methods.length > 0) d.protoMethods = methods;
          }
          storeDetails[k] = d;
        }
      } catch (e) {
        storeDetails[k] = { error: e.message };
      }
    }
    out.storeDetails = storeDetails;
  }

  // 2. 查 imSdkService 的结构
  if (instance.imSdkService) {
    const svc = instance.imSdkService;
    out.imSdkServiceKeys = Object.keys(svc).slice(0, 30);
    out.imSdkServiceProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(svc),
    ).slice(0, 50);

    // 查 imSdkManager 上的所有方法（包括从 prototype 继承的）
    const mgr = svc.imSdkManager;
    if (mgr) {
      out.imSdkManagerAllKeys = [];
      let p = mgr;
      while (p && p !== Object.prototype) {
        out.imSdkManagerAllKeys.push(...Object.getOwnPropertyNames(p));
        p = Object.getPrototypeOf(p);
      }
      // 去重
      out.imSdkManagerAllKeys = [...new Set(out.imSdkManagerAllKeys)];

      // 查 initResult / imSdkInstance（可能不通过 getImSdkInstance 而是直接属性）
      if (mgr.initResult !== undefined) out.initResult = typeof mgr.initResult;
      if (mgr.imSdkInstance !== undefined) {
        out.imSdkInstanceDirectFound = true;
        const sdk = mgr.imSdkInstance;
        out.imSdkInstanceDirectKeys = Object.keys(sdk).slice(0, 80);

        // 查 plugins 数组
        if (sdk.plugins && Array.isArray(sdk.plugins)) {
          out.pluginsCount = sdk.plugins.length;
          const pluginMethods = [];
          for (let i = 0; i < sdk.plugins.length; i++) {
            const plugin = sdk.plugins[i];
            if (plugin && typeof plugin === 'object') {
              const pluginInfo = {
                index: i,
                name: plugin.name || '<unnamed>',
                keys: Object.keys(plugin).slice(0, 20),
                protoMethods: [],
              };
              let proto = Object.getPrototypeOf(plugin);
              while (proto && proto !== Object.prototype) {
                for (const n of Object.getOwnPropertyNames(proto)) {
                  if (n !== 'constructor' && typeof plugin[n] === 'function') {
                    pluginInfo.protoMethods.push(n);
                  }
                }
                proto = Object.getPrototypeOf(proto);
              }
              pluginMethods.push(pluginInfo);
            }
          }
          out.pluginsDetails = pluginMethods;
        }
      }
    }
  }

  // 3. 查 requestManager（HTTP 请求层，可能含签名）
  if (instance.requestManager) {
    const rm = instance.requestManager;
    out.requestManagerKeys = Object.keys(rm).slice(0, 30);
    out.requestManagerProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(rm),
    ).slice(0, 50);
    if (typeof rm.request === 'function') {
      out.requestMethodSnippet = rm.request.toString().slice(0, 500);
    }
  }

  // 4. 查 utilsManager（可能有 downloadFile 等实用方法）
  if (instance.utilsManager) {
    out.utilsManagerKeys = Object.keys(instance.utilsManager).slice(0, 30);
    out.utilsManagerProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(instance.utilsManager),
    ).slice(0, 50);
  }

  return out;
})()
