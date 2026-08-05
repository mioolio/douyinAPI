// 探查 React Context 对象的所有属性，找 Provider 的当前值
(async () => {
  const out = {};

  const vmokIm = window['__VMOK_@pc-im/im:1.0.0.696__'];
  if (!vmokIm || !vmokIm.get) {
    out.error = 'no vmokIm';
    return out;
  }

  const loaderFn = await vmokIm.get('.');
  if (typeof loaderFn !== 'function') {
    out.error = 'loader is not function';
    return out;
  }

  const mod = await loaderFn();
  if (!mod || !mod.Context) {
    out.error = 'no Context in module';
    return out;
  }

  const ctx = mod.Context;
  out.contextType = typeof ctx;
  out.contextKeys = Object.keys(ctx).slice(0, 30);
  out.contextOwnProps = Object.getOwnPropertyNames(ctx).slice(0, 50);

  // 看每个属性的类型和值
  const propDetails = {};
  for (const k of Object.getOwnPropertyNames(ctx)) {
    try {
      const v = ctx[k];
      const d = { type: typeof v };
      if (v && typeof v === 'object') {
        d.keys = Object.keys(v).slice(0, 30);
        // 重点：含 imSdkService / conversationStore 的属性
        if (v.imSdkService || v.conversationStore || v.mainOptions || v.curMessageListStore) {
          d.hasImContext = true;
          d.imSdkServiceFound = !!v.imSdkService;
          d.conversationStoreFound = !!v.conversationStore;
          d.mainOptionsFound = !!v.mainOptions;

          // 深入看 imSdkService.imSdkManager.getImSdkInstance
          if (v.imSdkService && v.imSdkService.imSdkManager) {
            const mgr = v.imSdkService.imSdkManager;
            d.imSdkManagerKeys = Object.keys(mgr).slice(0, 30);
            d.imSdkManagerProto = Object.getOwnPropertyNames(
              Object.getPrototypeOf(mgr),
            ).slice(0, 50);
            if (typeof mgr.getImSdkInstance === 'function') {
              try {
                const sdk = await mgr.getImSdkInstance();
                if (sdk) {
                  d.imSdkInstanceFound = true;
                  d.imSdkInstanceKeys = Object.keys(sdk).slice(0, 50);
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
                  d.imSdkProtoMethods = methods;
                }
              } catch (e) {
                d.getImSdkInstanceError = e.message;
              }
            }
          }

          // 深入看 conversationStore
          if (v.conversationStore) {
            const cs = v.conversationStore;
            d.conversationStoreKeys = Object.keys(cs).slice(0, 50);
            d.conversationStoreProto = Object.getOwnPropertyNames(
              Object.getPrototypeOf(cs),
            ).slice(0, 80);
          }

          // 深入看 mainOptions
          if (v.mainOptions) {
            d.mainOptionsKeys = Object.keys(v.mainOptions).slice(0, 30);
            if (v.mainOptions.userInfo) {
              d.userInfo = {
                uid: v.mainOptions.userInfo.uid,
                secUid: v.mainOptions.userInfo.secUid ? '<has>' : null,
                nickname: v.mainOptions.userInfo.nickname,
              };
            }
          }
        }
      } else if (typeof v === 'function') {
        d.snippet = v.toString().slice(0, 200);
      }
      propDetails[k] = d;
    } catch (e) {
      propDetails[k] = { error: e.message };
    }
  }
  out.contextPropDetails = propDetails;

  // 策略 2：查 Context.Provider 的内部属性
  if (ctx.Provider) {
    const provider = ctx.Provider;
    out.providerType = typeof provider;
    out.providerOwnProps = Object.getOwnPropertyNames(provider).slice(0, 50);

    // Provider 的 _currentValue / _currentValue2 / _defaultValue / _defaultValue2
    const providerProps = {};
    for (const k of Object.getOwnPropertyNames(provider)) {
      try {
        const v = provider[k];
        if (v && typeof v === 'object') {
          if (v.imSdkService || v.conversationStore || v.mainOptions) {
            providerProps[k] = {
              type: typeof v,
              hasImContext: true,
              imSdkServiceFound: !!v.imSdkService,
              conversationStoreFound: !!v.conversationStore,
              mainOptionsFound: !!v.mainOptions,
            };
          } else {
            providerProps[k] = { type: typeof v, keys: Object.keys(v).slice(0, 10) };
          }
        } else {
          providerProps[k] = { type: typeof v, value: String(v).slice(0, 100) };
        }
      } catch (e) {
        providerProps[k] = { error: e.message };
      }
    }
    out.providerPropDetails = providerProps;
  }

  // 策略 3：遍历 fiber 查 Context Provider 节点
  // Provider 节点的 type 是 Context.Provider 对象
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
      const visited = new Set();
      const found = [];
      const search = (f, depth, maxDepth) => {
        if (!f || depth > maxDepth || visited.has(f)) return;
        visited.add(f);
        // Provider 节点的 type 是 Context.Provider（含 _context 属性）
        if (f.type === ctx.Provider || (f.type && f.type._context === ctx)) {
          found.push({
            path: 'depth' + depth,
            valueType: typeof f.type,
            memoizedValueKeys: f.memoizedProps && typeof f.memoizedProps.value === 'object'
              ? Object.keys(f.memoizedProps.value).slice(0, 30)
              : null,
          });
        }
        search(f.child, depth + 1, maxDepth);
        search(f.sibling, depth + 1, maxDepth);
      };
      search(fiber, 0, 100);

      out.providerNodesFound = found.length;
      out.providerNodeDetails = found;
    }
  } catch (e) {
    out.fiberSearchError = e.message;
  }

  return out;
})()
