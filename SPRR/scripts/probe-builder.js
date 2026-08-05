// 探查 createMessageBuilder 和 MessageBuilder 的结构
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

  const ssm = instance.imSdkService.sendMessageManager;

  // 1. createMessageBuilder 函数体
  if (typeof ssm.createMessageBuilder === 'function') {
    out.createMessageBuilderSnippet = ssm.createMessageBuilder.toString().slice(0, 3000);
  }

  // 2. 尝试用当前会话创建一个 builder（不发送，只看结构）
  // 先获取当前会话
  const cs = instance.store.conversationStore;
  const curConvId = cs.curConversationId;
  out.curConversationId = curConvId;

  if (curConvId) {
    const curConv = cs.conversationMap.get(curConvId);
    if (curConv) {
      out.curConvKeys = Object.keys(curConv).slice(0, 30);
      // 看会话的基本信息
      out.curConvInfo = {
        conversationId: curConv.conversationId,
        conversationShortId: curConv.conversationShortId,
        conversationType: curConv.conversationType,
        name: curConv.name,
        targetUser: curConv.targetUser ? {
          uid: curConv.targetUser.uid,
          secUid: curConv.targetUser.secUid ? '<has>' : null,
          nickname: curConv.targetUser.nickname,
        } : null,
      };

      // 尝试创建 builder
      try {
        const builder = await ssm.createMessageBuilder({
          conversation: curConv,
          content: 'test_from_probe',
          messageType: 'text',
        });
        out.builderCreated = true;
        out.builderKeys = Object.keys(builder).slice(0, 30);
        out.builderProto = Object.getOwnPropertyNames(
          Object.getPrototypeOf(builder),
        ).slice(0, 50);

        // 看 builder 的方法
        const builderMethods = {};
        for (const k of Object.keys(builder)) {
          if (typeof builder[k] === 'function') {
            builderMethods[k] = builder[k].toString().slice(0, 300);
          }
        }
        out.builderMethods = builderMethods;
      } catch (e) {
        out.builderCreateError = e.message;
        // 尝试不同参数
        try {
          const builder = await ssm.createMessageBuilder(curConv, 'test_from_probe');
          out.builderCreatedV2 = true;
          out.builderKeysV2 = Object.keys(builder).slice(0, 30);
        } catch (e2) {
          out.builderCreateErrorV2 = e2.message;
        }
      }
    }
  }

  // 3. 尝试直接调用 conversationListManager.getAllConversation 看返回结构
  try {
    const list = await instance.imSdkService.conversationListManager.getAllConversation();
    out.allConversationListType = typeof list;
    if (Array.isArray(list)) {
      out.allConversationListLength = list.length;
      if (list.length > 0) {
        out.allConversationFirstItemKeys = Object.keys(list[0]).slice(0, 30);
        out.allConversationFirstItem = {
          conversationId: list[0].conversationId,
          conversationShortId: list[0].conversationShortId,
          name: list[0].name,
          targetUser: list[0].targetUser ? {
            uid: list[0].targetUser.uid,
            nickname: list[0].targetUser.nickname,
          } : null,
        };
      }
    } else if (list && typeof list === 'object') {
      out.allConversationListKeys = Object.keys(list).slice(0, 30);
    }
  } catch (e) {
    out.getAllConversationError = e.message;
  }

  // 4. messageListFactoty.get(conversationId) 看消息列表
  if (curConvId) {
    try {
      const mlf = instance.imSdkService.messageListFactoty;
      const msgList = mlf.get(curConvId);
      if (msgList) {
        out.msgListFound = true;
        out.msgListKeys = Object.keys(msgList).slice(0, 30);
        out.msgListProto = Object.getOwnPropertyNames(
          Object.getPrototypeOf(msgList),
        ).slice(0, 80);
      } else {
        out.msgListNull = true;
      }
    } catch (e) {
      out.msgListError = e.message;
    }
  }

  return out;
})()
