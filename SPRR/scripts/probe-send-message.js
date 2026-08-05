// 深入查 sendMessageManager 和相关方法
(async () => {
  const out = {};

  const vmokIm = window['__VMOK_@pc-im/im:1.0.0.696__'];
  const loaderFn = await vmokIm.get('.');
  const mod = await loaderFn();
  const ctx = mod.Context;
  const instance = ctx.instance;

  if (!instance) {
    out.error = 'no instance';
    return out;
  }

  // 1. sendMessageManager - 重点！
  const ssm = instance.imSdkService.sendMessageManager;
  if (ssm) {
    out.sendMessageManagerKeys = Object.keys(ssm).slice(0, 50);
    out.sendMessageManagerProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(ssm),
    ).slice(0, 80);

    // 看每个方法名，找含 send 的
    const sendMethods = [];
    for (const k of Object.keys(ssm)) {
      if (typeof ssm[k] === 'function' && k.toLowerCase().includes('send')) {
        sendMethods.push({
          name: k,
          snippet: ssm[k].toString().slice(0, 1000),
        });
      }
    }
    out.sendMethodsInSendMessageManager = sendMethods;

    // 也看 prototype 上的
    const proto = Object.getPrototypeOf(ssm);
    if (proto && proto !== Object.prototype) {
      const protoSendMethods = [];
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k !== 'constructor' && typeof proto[k] === 'function' && k.toLowerCase().includes('send')) {
          protoSendMethods.push({
            name: k,
            snippet: proto[k].toString().slice(0, 1000),
          });
        }
      }
      out.sendProtoMethodsInSendMessageManager = protoSendMethods;
    }
  }

  // 2. conversationListManager
  const clm = instance.imSdkService.conversationListManager;
  if (clm) {
    out.conversationListManagerKeys = Object.keys(clm).slice(0, 50);
    out.conversationListManagerProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(clm),
    ).slice(0, 80);
  }

  // 3. conversationManager
  const cm = instance.imSdkService.conversationManager;
  if (cm) {
    out.conversationManagerKeys = Object.keys(cm).slice(0, 50);
    out.conversationManagerProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(cm),
    ).slice(0, 80);
  }

  // 4. messageListFactoty
  const mlf = instance.imSdkService.messageListFactoty;
  if (mlf) {
    out.messageListFactotyKeys = Object.keys(mlf).slice(0, 50);
    out.messageListFactotyProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(mlf),
    ).slice(0, 80);
  }

  // 5. frontierMessageManager
  const fmm = instance.imSdkService.frontierMessageManager;
  if (fmm) {
    out.frontierMessageManagerKeys = Object.keys(fmm).slice(0, 50);
    out.frontierMessageManagerProto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(fmm),
    ).slice(0, 80);
  }

  // 6. utilsManager.getSendMessageCallback 函数体
  if (instance.utilsManager && typeof instance.utilsManager.getSendMessageCallback === 'function') {
    out.getSendMessageCallbackSnippet = instance.utilsManager.getSendMessageCallback.toString().slice(0, 2000);
  }

  // 7. requestManager.request 函数体完整版
  if (instance.requestManager && typeof instance.requestManager.request === 'function') {
    out.requestFullSnippet = instance.requestManager.request.toString().slice(0, 3000);
  }

  // 8. conversationStore.curConversationId（当前会话）
  if (instance.store && instance.store.conversationStore) {
    const cs = instance.store.conversationStore;
    out.curConversationId = cs.curConversationId;
    out.conversationMapSize = cs.conversationMap ? cs.conversationMap.size : null;
    out.conversationMapKeys = cs.conversationMap ? [...cs.conversationMap.keys()].slice(0, 20) : null;

    // 看当前会话的属性
    if (cs.curConversationId && cs.conversationMap) {
      const cur = cs.conversationMap.get(cs.curConversationId);
      if (cur) {
        out.curConversationKeys = Object.keys(cur).slice(0, 30);
        if (cur.targetUser) {
          out.curConversationTargetUser = {
            uid: cur.targetUser.uid,
            secUid: cur.targetUser.secUid ? '<has>' : null,
            nickname: cur.targetUser.nickname,
          };
        }
      }
    }
  }

  return out;
})()
