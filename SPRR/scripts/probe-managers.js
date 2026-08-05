// 探查 conversationListManager / messageListFactoty 的可用方法
(async () => {
  const out = {};

  const vmokKey = Object.keys(window).find((k) =>
    k.startsWith('__VMOK_@pc-im/im'),
  );
  if (!vmokKey) return { error: 'no vmok' };
  const vmok = window[vmokKey];
  const loader = await vmok.get('.');
  const mod = await loader();
  const instance = mod.Context && mod.Context.instance;
  if (!instance) return { error: 'no instance' };

  const svc = instance.imSdkService;

  // conversationListManager 完整探查
  const clm = svc.conversationListManager;
  if (clm) {
    out.conversationListManager = {
      ownKeys: Object.keys(clm),
      proto: Object.getOwnPropertyNames(Object.getPrototypeOf(clm)),
    };
    // 列出所有函数
    const fns = [];
    for (const k of Object.keys(clm)) {
      if (typeof clm[k] === 'function') {
        fns.push({ name: k, snippet: clm[k].toString().slice(0, 200) });
      }
    }
    out.conversationListManagerFns = fns;
  }

  // conversationManager
  const cm = svc.conversationManager;
  if (cm) {
    const fns = [];
    for (const k of Object.keys(cm)) {
      if (typeof cm[k] === 'function') {
        fns.push({ name: k, snippet: cm[k].toString().slice(0, 200) });
      }
    }
    out.conversationManagerFns = fns;
  }

  // messageListFactoty
  const mlf = svc.messageListFactoty;
  if (mlf) {
    out.messageListFactoty = {
      ownKeys: Object.keys(mlf),
      proto: Object.getOwnPropertyNames(Object.getPrototypeOf(mlf)),
    };
    const fns = [];
    for (const k of Object.keys(mlf)) {
      if (typeof mlf[k] === 'function') {
        fns.push({ name: k, snippet: mlf[k].toString().slice(0, 200) });
      }
    }
    out.messageListFactotyFns = fns;
  }

  // imSdkInstance - 看 createMessage/sendMessage 的真实签名
  const sdk = instance.imSdkInstance;
  if (sdk) {
    out.imSdkInstanceKeys = Object.keys(sdk);
    out.imSdkInstanceProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(sdk),
    );
  }

  // store 探查
  if (instance.store) {
    out.storeKeys = Object.keys(instance.store);
    const cs = instance.store.conversationStore;
    if (cs) {
      out.conversationStoreKeys = Object.keys(cs);
      out.conversationMapSize = cs.conversationMap ? cs.conversationMap.size : 0;
      out.conversationMapKeys = cs.conversationMap ? [...cs.conversationMap.keys()].slice(0, 30) : [];
      // 触发拉取的相关字段
      out.conversationStoreProto = Object.getOwnPropertyNames(
        Object.getPrototypeOf(cs),
      );
    }
    const ms = instance.store.messageStore;
    if (ms) {
      out.messageStoreKeys = Object.keys(ms);
      out.messageStoreProto = Object.getOwnPropertyNames(
        Object.getPrototypeOf(ms),
      );
    }
  }

  // eventBus / events - 看是否有"列表已拉取"事件
  if (svc.eventBus) {
    out.eventBusKeys = Object.keys(svc.eventBus);
  }

  return out;
})()
