// 这个文件在浏览器中执行，必须是纯 JS（无 TS 注解）
// 从 React fiber 树和 VMOK 模块中提取已初始化的 IM SDK 实例
// IIFE 形式：page.evaluate(string) 要求字符串是表达式
(async () => {
  const out = {};

  // ===== 策略 1：从 VMOK Context._currentValue 拿 =====
  // 已知：vmokIm.get('.')() 返回模块 83767 导出
  // 模块 83767 导出: { Context, IM, mountIM, ... }
  // Context 是 React Context 对象，其 _currentValue 是 Provider 的当前值
  try {
    const vmokIm = window['__VMOK_@pc-im/im:1.0.0.696__'];
    if (vmokIm && vmokIm.get) {
      const loaderFn = await vmokIm.get('.');
      if (typeof loaderFn === 'function') {
        const mod = await loaderFn();
        out.moduleExportKeys = mod ? Object.keys(mod) : null;

        if (mod && mod.Context) {
          out.contextFound = true;
          // React Context 内部属性：_currentValue / _currentValue2 / Provider
          const ctx = mod.Context;
          const currentValue = ctx._currentValue || ctx._currentValue2;
          if (currentValue) {
            out.contextValueType = typeof currentValue;
            out.contextValueKeys = Object.keys(currentValue).slice(0, 30);

            // 查 imSdkService
            if (currentValue.imSdkService) {
              out.imSdkServiceFound = true;
              const svc = currentValue.imSdkService;
              out.imSdkServiceKeys = Object.keys(svc).slice(0, 30);
              const mgr = svc.imSdkManager;
              if (mgr) {
                out.imSdkManagerKeys = Object.keys(mgr).slice(0, 30);
                if (typeof mgr.getImSdkInstance === 'function') {
                  try {
                    const sdk = await mgr.getImSdkInstance();
                    if (sdk) {
                      out.imSdkInstanceFound = true;
                      out.imSdkKeys = Object.keys(sdk).slice(0, 50);
                      const methods = [];
                      let proto = Object.getPrototypeOf(sdk);
                      while (proto && proto !== Object.prototype) {
                        for (const n of Object.getOwnPropertyNames(proto)) {
                          if (n !== 'constructor' && typeof proto[n] === 'function') {
                            methods.push(n);
                          }
                        }
                        proto = Object.getPrototypeOf(proto);
                      }
                      out.imSdkProtoMethods = methods;
                    }
                  } catch (e) {
                    out.getImSdkInstanceError = e.message;
                  }
                }
              }
            }

            // 查 conversationStore
            if (currentValue.conversationStore) {
              out.conversationStoreFound = true;
              const cs = currentValue.conversationStore;
              out.conversationStoreKeys = Object.keys(cs).slice(0, 50);
              const csp = Object.getOwnPropertyNames(Object.getPrototypeOf(cs));
              out.conversationStoreProto = csp.slice(0, 80);
            }

            // 查 curMessageListStore
            if (currentValue.curMessageListStore) {
              out.curMessageListStoreFound = true;
              const ms = currentValue.curMessageListStore;
              out.curMessageListStoreKeys = Object.keys(ms).slice(0, 50);
              out.curMessageListStoreProto = Object.getOwnPropertyNames(
                Object.getPrototypeOf(ms),
              ).slice(0, 80);
            }

            // 查 mainOptions
            if (currentValue.mainOptions) {
              out.mainOptionsFound = true;
              out.mainOptionsKeys = Object.keys(currentValue.mainOptions).slice(0, 30);
              const ui = currentValue.mainOptions.userInfo;
              if (ui) {
                out.userInfo = {
                  uid: ui.uid,
                  secUid: ui.secUid ? '<has>' : null,
                  nickname: ui.nickname,
                };
              }
            }

            // 查 requestManager
            if (currentValue.requestManager) {
              out.requestManagerFound = true;
              out.requestManagerKeys = Object.keys(currentValue.requestManager).slice(0, 30);
            }
          } else {
            out.contextValueError = 'no _currentValue';
          }
        }
      }
    }
  } catch (e) {
    out.strategy1Error = e.message;
  }

  // ===== 策略 2：遍历 fiber，查 memoizedValue（Provider value）=====
  if (!out.imSdkInstanceFound && !out.conversationStoreFound) {
    try {
      const findReactFiber = (el) => {
        const keys = Object.keys(el);
        for (const k of keys) {
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
            return el[k];
          }
        }
        return null;
      };

      const container = document.getElementById('imSaasContainerId') || document.body;
      const fiber = findReactFiber(container);

      if (fiber) {
        out.fiberFound = true;
        const results = [];
        const visited = new Set();
        const searchFiber = (f, depth, maxDepth) => {
          if (!f || depth > maxDepth || visited.has(f)) return;
          visited.add(f);
          // 检查 memoizedValue（Context Provider 的 value）
          if (f.memoizedValue && typeof f.memoizedValue === 'object') {
            const mv = f.memoizedValue;
            if (mv.imSdkService || mv.conversationStore || mv.curMessageListStore || mv.mainOptions) {
              results.push({ path: 'memoizedValue@depth' + depth, value: mv });
            }
          }
          // 检查 stateNode.updater（hooks）
          if (f.stateNode && f.stateNode.updater && typeof f.stateNode.updater === 'object') {
            // 跳过，太杂
          }
          searchFiber(f.child, depth + 1, maxDepth);
          searchFiber(f.sibling, depth + 1, maxDepth);
        };
        searchFiber(fiber, 0, 100, visited);

        out.fiberMemoizedValueResults = results.length;
        if (results.length > 0) {
          const val = results[0].value;
          out.fiberValuePath = results[0].path;
          out.fiberValueKeys = Object.keys(val).slice(0, 30);
          if (val.conversationStore) {
            out.fiberConvStoreKeys = Object.keys(val.conversationStore).slice(0, 50);
          }
        }
      }
    } catch (e) {
      out.strategy2Error = e.message;
    }
  }

  return out;
})()
