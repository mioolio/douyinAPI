/**
 * 消息命令（list / send / send-image / send-sticker / reply / recall / history）
 */

import type { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import { createLogger } from '../utils/logger.js';
import { DATA_DIR } from '../config/paths.js';
import { C, catBox, divider, output, formatMessageLine, formatTable } from '../cli/ui.js';
import {
  run,
  getContacts,
  resolveTarget,
  getStatePathForBrowser,
  loadAliases,
  buildPrivateCid,
  detectMyUid,
} from '../cli/context.js';
import {
  listContacts,
  sendMessage,
  sendImage,
  sendSticker,
  sendQuoteReply,
  recallMessage,
  getHistoryAll,
  getHistory,
  type ContactItem,
  type MessageItem,
  type SendSignContext,
  type ImageSendInfo,
  type StickerSendInfo,
  type QuoteReplyRef,
} from '../api/operations.js';
import { getUserInfoMap, getReadOnceImage, buildImageUrl } from '../api/webapi.js';
import { uploadImage } from '../api/tos.js';
import { captureSendRequests } from './capture-send.js';
import {
  sendViaBrowser,
  sendQuoteReplyViaBrowser,
  type BrowserSendSign,
} from './browser-send.js';

const log = createLogger('cmd-message');

/** 加载联系人并应用别名 */
async function loadContactsWithAliases(
  env: ReturnType<typeof import('../api/operations.js').envFromSession>,
): Promise<{ contacts: ContactItem[]; myUid: string }> {
  const contacts = await getContacts(env);
  const aliases = await loadAliases();
  for (const c of contacts) {
    if (aliases[c.uid]) c.nickname = aliases[c.uid];
  }
  const myUid = detectMyUid(contacts);
  return { contacts, myUid };
}

export function registerMessageCommands(program: Command): void {
  /* --------------------------- list --------------------------- */
  program
    .command('list')
    .description('列出所有会话（联系人）')
    .action(async () => {
      await run(async ({ env }) => {
        const contacts = await listContacts(env);
        const aliases = await loadAliases();
        const secUidsToFetch = contacts
          .filter((c) => c.secUid && c.nickname === '(pending)')
          .map((c) => c.secUid!) as string[];
        if (secUidsToFetch.length > 0) {
          log.info(`list: 批量获取 ${secUidsToFetch.length} 个用户的 nickname...`);
          const userInfoMap = await getUserInfoMap(env, secUidsToFetch);
          let resolvedCount = 0;
          for (const c of contacts) {
            if (!c.secUid) continue;
            const info = userInfoMap.get(c.secUid);
            if (info && info.nickname) {
              c.nickname = info.nickname;
              resolvedCount++;
            } else if (c.nickname === '(pending)') {
              c.nickname = `(uid:${c.uid.slice(-6)})`;
            }
          }
          log.info(`list: 成功获取 ${resolvedCount}/${secUidsToFetch.length} 个 nickname`);
        }
        for (const c of contacts) {
          if (aliases[c.uid]) c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        output(contacts, (data) => {
          log.info(`共 ${C.bold}${data.length}${C.reset} 个会话`);
          if (myUid) log.info(`当前账号 UID: ${C.cyan}${myUid}${C.reset}`);
          console.log(divider());
          console.log(formatTable(
            ['#', '昵称', 'UID', '未读', '会话ID'],
            data.map((c, i) => [
              String(i + 1),
              c.nickname || '(未知)',
              c.uid || '-',
              c.unreadCount !== undefined ? (c.unreadCount > 0 ? `${C.brightRed}${c.unreadCount}${C.reset}` : '0') : '-',
              c.conversationId,
            ]),
          ));
          console.log(divider());
          log.info(`提示: 使用 rename --uid <uid> --name <昵称> 设置备注名`);
        });
      });
    });

  /* --------------------------- send --------------------------- */
  program
    .command('send')
    .description('向指定用户发送文本消息')
    .option('-t, --text <text>', '消息内容（--dev 模式下可省略）')
    .option('--to <target>', '目标用户 uid 或昵称', 'TwT')
    .option('--dev', '开发模式：启动已登录浏览器抓包 /v1/message/send 请求（不实际发送）')
    .option('--out', '抓包结果保存到 data/capture/send/ 目录（与 --dev 配合使用）')
    .option('--native', '使用纯 Node.js 原生发送（需手动签名，可能失败）')
    .option('--show-browser', '显示浏览器窗口（默认无头）')
    .action(async (opts: { text?: string; to: string; dev?: boolean; out?: boolean; native?: boolean; showBrowser?: boolean }) => {
      if (opts.dev) {
        log.info(`${C.brightYellow}[开发模式]${C.reset} 启动浏览器抓包 /v1/message/send 请求`);
        log.info(`${C.brightYellow}[开发模式]${C.reset} 忽略 --to 和 --text 参数，请在浏览器中手动发送`);
        log.info(`${C.brightYellow}[开发模式]${C.reset} 抓包结果${opts.out ? '保存到 data/capture/send/' : '仅打印到终端'}`);
        try {
          const statePath = await getStatePathForBrowser();
          const captured = await captureSendRequests({
            storageStatePath: statePath,
            headless: false,
          });
          if (captured.length === 0) {
            log.warn('未捕获到任何 /v1/message/send 请求');
          } else {
            log.info(`共捕获 ${captured.length} 个请求`);
            if (opts.out) {
              log.info(`抓包文件已保存到 ${C.cyan}data/capture/send/${C.reset}`);
            }
          }
        } catch (e) {
          log.error('抓包异常', e);
        }
        return;
      }

      if (!opts.text) {
        log.error('缺少必填参数: -t, --text <text>（或使用 --dev 进入抓包模式）');
        return;
      }
      const text = opts.text;

      await run(async ({ env }) => {
        const { contacts, myUid } = await loadContactsWithAliases(env);
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
          log.error(`找不到目标用户: ${opts.to}`);
          return;
        }
        log.info(`发送给: ${C.cyan}${target.nickname}${C.reset} (uid=${target.uid})`);
        log.info(`消息内容: ${text}`);
        const cid = buildPrivateCid(myUid, target.uid);

        if (opts.native) {
          log.info(`${C.gray}使用原生发送模式（--native）${C.reset}`);
          const sign: SendSignContext = {
            conversationShortId: target.conversationShortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendMessage(env, cid, text, sign);
          output(result, (data) => {
            if (data.success) {
              catBox('发送成功');
              if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
            } else {
              log.error(`发送失败: ${data.reason || '未知原因'}`);
            }
          });
        } else {
          log.info(`${C.gray}使用浏览器发送模式（默认，--native 切换原生）${C.reset}`);
          const statePath = await getStatePathForBrowser();
          const sign: BrowserSendSign = {
            conversationShortId: target.conversationShortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendViaBrowser(
            statePath,
            env,
            cid,
            text,
            sign,
            !opts.showBrowser,
          );
          output(result, (data) => {
            if (data.success) {
              catBox('发送成功');
              if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
            } else {
              log.error(`发送失败: ${data.reason || '未知原因'}`);
            }
          });
        }
      });
    });

  /* --------------------------- recall --------------------------- */
  program
    .command('recall')
    .description('撤回指定消息')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--cid <conversationId>', '直接指定 conversationId')
    .option('--msg-id <serverMsgId>', '指定要撤回的 server_message_id')
    .action(async (opts: { to: string; cid?: string; msgId?: string }) => {
      await run(async ({ env }) => {
        const { contacts, myUid } = await loadContactsWithAliases(env);
        let conversationId: string;
        let conversationShortId: string;
        let targetLabel: string;
        if (opts.cid) {
          const c = contacts.find((x) => x.conversationId === opts.cid);
          if (!c || !c.conversationShortId) {
            log.error(`找不到会话: ${opts.cid}`);
            return;
          }
          conversationId = opts.cid;
          conversationShortId = c.conversationShortId;
          targetLabel = c.nickname || c.uid;
        } else {
          const target = await resolveTarget(env, opts.to, myUid, contacts);
          if (!target) {
            log.error(`找不到目标用户: ${opts.to}`);
            return;
          }
          conversationId = buildPrivateCid(myUid, target.uid);
          conversationShortId = target.conversationShortId;
          targetLabel = target.nickname;
        }
        log.info(`目标会话: ${targetLabel} cid=${conversationId} shortId=${conversationShortId}`);
        let serverMsgId = opts.msgId;
        if (!serverMsgId) {
          log.info(`未指定 --msg-id，拉取最近消息...`);
          const messages = await getHistory(env, conversationId, {
            direction: 3,
            limit: 20,
            conversationShortId,
            myUid,
          });
          const myMsg = messages.find((m) => m.isSelf);
          if (!myMsg || !myMsg.serverMsgId) {
            log.error(`未找到自己发送的消息（最近 ${messages.length} 条内）`);
            return;
          }
          serverMsgId = myMsg.serverMsgId;
          log.info(`找到最近一条自己发的消息: serverMsgId=${serverMsgId}`);
        }
        const result = await recallMessage(env, conversationId, serverMsgId, conversationShortId);
        output(result, (data) => {
          if (data.success) {
            catBox('撤回成功');
          } else {
            log.error(`撤回失败: ${data.reason || '未知原因'}`);
          }
        });
      });
    });

  /* --------------------------- send-image --------------------------- */
  program
    .command('send-image')
    .description('向指定用户发送图片消息')
    .requiredOption('-i, --image <path>', '图片文件路径')
    .option('--to <target>', '目标用户', 'TwT')
    .action(async (opts: { image: string; to: string }) => {
      await run(async ({ env }) => {
        let imageBytes: Buffer;
        try {
          imageBytes = await fs.readFile(opts.image);
        } catch (e) {
          log.error(`读取图片失败: ${opts.image}`, e);
          return;
        }
        log.info(`图片: ${opts.image} (${imageBytes.length} 字节)`);
        const { contacts, myUid } = await loadContactsWithAliases(env);
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
          log.error(`找不到目标用户: ${opts.to}`);
          return;
        }
        log.info(`发送给: ${C.cyan}${target.nickname}${C.reset} (uid=${target.uid})`);
        const commit = await uploadImage(env, imageBytes, myUid);
        if (!commit) {
          log.error(`上传图片失败，终止发送`);
          return;
        }
        const cid = buildPrivateCid(myUid, target.uid);
        const imageInfo: ImageSendInfo = {
          oid: commit.encryptionUri,
          skey: commit.secretKey,
          md5: commit.sourceMd5,
          dataSize: commit.imgSize || imageBytes.length,
          width: commit.imgWidth,
          height: commit.imgHeight,
        };
        const sign: SendSignContext = {
          conversationShortId: target.conversationShortId,
          conversationType: 1,
          ticket: target.ticket || '',
        };
        const result = await sendImage(env, cid, imageInfo, sign);
        output(result, (data) => {
          if (data.success) {
            catBox('图片发送成功');
            if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
          } else {
            log.error(`发送失败: ${data.reason || '未知原因'}`);
          }
        });
      });
    });

  /* --------------------------- history --------------------------- */
  program
    .command('history')
    .description('获取指定会话的聊天记录')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--cid <conversationId>', '直接指定 conversationId')
    .option('--limit <count>', '拉取条数', '30')
    .action(async (opts: { to: string; cid?: string; limit: string }) => {
      await run(async ({ env }) => {
        const { contacts, myUid } = await loadContactsWithAliases(env);
        let cid = opts.cid;
        let shortId: string | undefined;
        let nickname = '(指定会话)';
        if (!cid) {
          const target = await resolveTarget(env, opts.to, myUid, contacts);
          if (!target) {
            log.error(`找不到目标用户: ${opts.to}`);
            return;
          }
          cid = buildPrivateCid(myUid, target.uid);
          shortId = target.conversationShortId;
          nickname = target.nickname;
        } else {
          const c = contacts.find((x) => x.conversationId === cid);
          if (c) {
            shortId = c.conversationShortId;
            nickname = c.nickname;
          } else {
            log.error(`未找到会话: ${cid}`);
            return;
          }
        }
        if (!shortId) {
          log.error(`无法获取 conversation_short_id`);
          return;
        }
        const limit = parseInt(opts.limit, 10) || 30;
        log.info(`会话: ${C.cyan}${nickname}${C.reset}  cid=${cid}  shortId=${shortId}  limit=${limit}`);

        let messages: MessageItem[];
        if (limit > 50) {
          messages = await getHistoryAll(env, cid, {
            conversationShortId: shortId,
            myUid,
            pageSize: 50,
            maxMessages: limit,
          });
        } else {
          messages = await getHistory(env, cid, {
            conversationShortId: shortId,
            limit,
            myUid,
          });
        }

        // 图片解密
        const decodedDir = path.join(DATA_DIR, 'decoded');
        await fs.mkdir(decodedDir, { recursive: true });

        async function downloadAndDecrypt(url: string, skey: string, oid: string): Promise<boolean> {
          try {
            const cipherRes = await fetch(url, {
              headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.douyin.com/' },
            });
            if (!cipherRes.ok) {
              log.warn(`  下载失败 HTTP ${cipherRes.status}`);
              return false;
            }
            const ciphertext = Buffer.from(await cipherRes.arrayBuffer());
            const key = Buffer.from(skey, 'hex');
            const nonce = ciphertext.subarray(0, 12);
            const tag = ciphertext.subarray(ciphertext.length - 16);
            const data = ciphertext.subarray(12, ciphertext.length - 16);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(data), decipher.final()]);
            let ext = 'bin';
            if (plain.length >= 12) {
              if (plain[0] === 0xff && plain[1] === 0xd8) ext = 'jpg';
              else if (plain[0] === 0x89 && plain[1] === 0x50) ext = 'png';
              else if (plain[0] === 0x52 && plain[8] === 0x57 && plain[9] === 0x45) ext = 'webp';
              else if (plain[0] === 0x47 && plain[1] === 0x49) ext = 'gif';
            }
            const fileName = (oid || 'douyin_image').replace(/[~:/]/g, '_') + '.' + ext;
            const outPath = path.join(decodedDir, fileName);
            await fs.writeFile(outPath, plain);
            log.info(`  已保存: ${outPath} (${plain.length} 字节, ${ext.toUpperCase()})`);
            return true;
          } catch (e) {
            log.warn(`  解密下载失败: ${e}`);
            return false;
          }
        }

        const plainImages = messages.filter((m) => m.category === 'image' && !m.isEncryptedImage && m.imageSkey);
        if (plainImages.length > 0) {
          const withUrl = plainImages.filter((m) => m.stickerUrl);
          const withoutUrl = plainImages.filter((m) => !m.stickerUrl);
          log.info(`检测到 ${plainImages.length} 条普通图片（有URL ${withUrl.length} / 无URL ${withoutUrl.length}），解密下载...`);
          let ok = 0;
          for (const m of withUrl) {
            const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1] || 'douyin_image';
            if (await downloadAndDecrypt(m.stickerUrl!, m.imageSkey!, oid)) ok++;
          }
          for (const m of withoutUrl) {
            const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1];
            if (!oid) { log.warn('  无 oid，跳过'); continue; }
            const urls = await buildImageUrl(env, oid);
            if (urls.length === 0) { log.warn(`  batch_build_image 失败 oid=${oid}`); continue; }
            m.stickerUrl = urls[0];
            m.text = '[图片]';
            if (await downloadAndDecrypt(urls[0], m.imageSkey!, oid)) ok++;
          }
          log.info(`普通图片解密完成: ${ok}/${plainImages.length} 成功`);
        }

        const encryptedMsgs = messages.filter((m) => m.isEncryptedImage && m.serverMsgId);
        if (encryptedMsgs.length > 0) {
          log.info(`检测到 ${encryptedMsgs.length} 条加密图片，尝试解密...`);
          const shortIdStr = String(shortId);
          let decryptedCount = 0;
          let alreadyReadCount = 0;
          let savedCount = 0;
          for (const m of encryptedMsgs) {
            const info = await getReadOnceImage(env, m.serverMsgId!, shortIdStr);
            if (info) {
              m.stickerUrl = info.largeUrl;
              m.text = '[加密图片:已解密]';
              decryptedCount++;
              if (info.skey && (await downloadAndDecrypt(info.largeUrl, info.skey, info.oid))) {
                savedCount++;
              }
            } else {
              alreadyReadCount++;
            }
          }
          log.info(`加密图片解密完成: 成功 ${decryptedCount} | 已被查看过 ${alreadyReadCount} | 已保存 ${savedCount}`);
        }

        output(messages, (data) => {
          log.info(`共 ${C.bold}${data.length}${C.reset} 条消息`);
          console.log(divider());
          for (const m of data) {
            console.log(formatMessageLine(m));
          }
          console.log(divider());
          const stats = {
            text: data.filter((m) => m.category === 'text').length,
            video_share: data.filter((m) => m.category === 'video_share').length,
            ai_text: data.filter((m) => m.category === 'ai_text').length,
            system_tip: data.filter((m) => m.category === 'system_tip').length,
            sticker: data.filter((m) => m.category === 'sticker').length,
            image: data.filter((m) => m.category === 'image').length,
            recall: data.filter((m) => m.category === 'recall').length,
            other: data.filter((m) => m.category === 'unknown').length,
          };
          log.info(
            `${C.magenta}统计${C.reset}: 文本 ${stats.text} | 分享视频 ${stats.video_share} | AI回复 ${stats.ai_text} | 系统提示 ${stats.system_tip} | 表情 ${stats.sticker} | 图片 ${stats.image} | 撤回 ${stats.recall} | 其他 ${stats.other}`,
          );
        });
      });
    });

  /* --------------------------- send-sticker --------------------------- */
  program
    .command('send-sticker')
    .description('发送表情贴纸消息')
    .option('-s, --sticker <path>', 'sticker 信息 JSON 文件路径')
    .option('-m, --from-msg <serverMsgId>', '从历史 sticker 消息中提取信息')
    .option('--to <target>', '目标用户', 'TwT')
    .action(async (opts: { sticker?: string; fromMsg?: string; to: string }) => {
      if (!opts.sticker && !opts.fromMsg) {
        log.error(`必须指定 --sticker <path> 或 --from-msg <serverMsgId>`);
        return;
      }
      await run(async ({ env }) => {
        const { contacts, myUid } = await loadContactsWithAliases(env);
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
          log.error(`找不到目标用户: ${opts.to}`);
          return;
        }
        log.info(`发送给: ${C.cyan}${target.nickname}${C.reset} (uid=${target.uid})`);
        let stickerInfo: StickerSendInfo;
        if (opts.fromMsg) {
          const cid = buildPrivateCid(myUid, target.uid);
          log.info(`查找 sticker 消息: serverMsgId=${opts.fromMsg}`);
          const messages = await getHistory(env, cid, {
            direction: 3,
            limit: 50,
            conversationShortId: target.conversationShortId,
            myUid,
          });
          const stickerMsg = messages.find((m) => m.serverMsgId === opts.fromMsg);
          if (!stickerMsg || stickerMsg.category !== 'sticker') {
            log.error(`未找到 sticker 消息（serverMsgId=${opts.fromMsg}）`);
            return;
          }
          const content = JSON.parse(stickerMsg.contentJson || '{}');
          const urlObj = content.url || {};
          stickerInfo = {
            imageId: content.image_id,
            packageId: content.package_id ?? 0,
            width: Number(content.width ?? urlObj.width ?? 300),
            height: Number(content.height ?? urlObj.height ?? 300),
            imageType: content.image_type ?? 'webp',
            uri: urlObj.uri ?? '',
            urlList: urlObj.url_list ?? [],
            displayName: content.display_name ?? '',
          };
        } else {
          try {
            const raw = await fs.readFile(opts.sticker!, 'utf-8');
            const obj = JSON.parse(raw);
            const urlObj = obj.url || {};
            stickerInfo = {
              imageId: obj.imageId ?? obj.image_id,
              packageId: obj.packageId ?? obj.package_id ?? 0,
              width: Number(obj.width ?? urlObj.width ?? 300),
              height: Number(obj.height ?? urlObj.height ?? 300),
              imageType: obj.imageType ?? obj.image_type ?? 'webp',
              uri: obj.uri ?? urlObj.uri ?? '',
              urlList: obj.urlList ?? urlObj.url_list ?? [],
              displayName: obj.displayName ?? obj.display_name ?? '',
            };
          } catch (e) {
            log.error(`读取 sticker 文件失败: ${opts.sticker}`, e);
            return;
          }
        }
        if (!stickerInfo.imageId || !stickerInfo.uri || stickerInfo.urlList.length === 0) {
          log.error(`sticker 信息不完整`);
          return;
        }
        const cid = buildPrivateCid(myUid, target.uid);
        const sign: SendSignContext = {
          conversationShortId: target.conversationShortId,
          conversationType: 1,
          ticket: target.ticket || '',
        };
        const result = await sendSticker(env, cid, stickerInfo, sign);
        output(result, (data) => {
          if (data.success) {
            catBox('表情发送成功');
          } else {
            log.error(`发送失败: ${data.reason || '未知原因'}`);
          }
        });
      });
    });

  /* --------------------------- reply --------------------------- */
  program
    .command('reply')
    .description('引用回复消息')
    .requiredOption('-t, --text <text>', '回复内容')
    .requiredOption('-r, --ref <serverMsgId>', '被引用消息的 server_message_id')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--native', '使用纯 Node.js 原生发送（需手动签名，可能失败）')
    .option('--show-browser', '显示浏览器窗口（默认无头模式）')
    .action(async (opts: { text: string; ref: string; to: string; native?: boolean; showBrowser?: boolean }) => {
      await run(async ({ env }) => {
        const { contacts, myUid } = await loadContactsWithAliases(env);
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
          log.error(`找不到目标用户: ${opts.to}`);
          return;
        }
        const cid = buildPrivateCid(myUid, target.uid);
        const shortId = target.conversationShortId;
        log.info(`查找被引用消息: serverMsgId=${opts.ref}`);
        const messages = await getHistory(env, cid, {
          direction: 3,
          limit: 50,
          conversationShortId: shortId,
          myUid,
        });
        const refMsg = messages.find((m) => m.serverMsgId === opts.ref);
        if (!refMsg) {
          log.error(`未找到 serverMsgId=${opts.ref} 的消息`);
          return;
        }
        log.info(`被引用消息: [${refMsg.category}] ${refMsg.text?.slice(0, 30)}`);
        const ref: QuoteReplyRef = {
          serverMsgId: refMsg.serverMsgId!,
          refmsgType: refMsg.messageType,
          refmsgUid: refMsg.senderId,
          refmsgSecUid: '',
          refmsgNickname: refMsg.senderLabel === '我' ? '我' : '对方',
          refmsgShortText: refMsg.text || '',
          refmsgContent: refMsg.contentJson || '{}',
        };
        if (opts.native) {
          log.info(`${C.gray}使用原生发送模式（--native）${C.reset}`);
          const sign: SendSignContext = {
            conversationShortId: shortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendQuoteReply(env, cid, opts.text, ref, sign);
          output(result, (data) => {
            if (data.success) {
              catBox('回复成功');
            } else {
              log.error(`回复失败: ${data.reason || '未知原因'}`);
            }
          });
        } else {
          log.info(`${C.gray}使用浏览器发送模式（默认，--native 切换原生）${C.reset}`);
          const statePath = await getStatePathForBrowser();
          const sign: BrowserSendSign = {
            conversationShortId: shortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendQuoteReplyViaBrowser(
            statePath,
            env,
            cid,
            opts.text,
            ref,
            sign,
            !opts.showBrowser,
          );
          output(result, (data) => {
            if (data.success) {
              catBox('回复成功');
              if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
            } else {
              log.error(`回复失败: ${data.reason || '未知原因'}`);
            }
          });
        }
      });
    });
}
