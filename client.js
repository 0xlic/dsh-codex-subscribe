window.__ModuleLoader__.load({
  id: '@lichen/dsh-codex-subscribe',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'codexSubscribe'
    const dictionaries = {
      en: {
        imagePreparing: 'Preparing image request…', imageWorking: 'Generating image…', imageReady: 'Image generated', imageFailed: 'Image unavailable — see details', imageOriginal: 'Open saved file', imageDetails: 'Technical details', imageAttachments: 'Attachments', imagePreview: 'Image preview', imageSavedFile: 'Saved file', imagePreviewSize: 'Preview dimensions', imageOriginalSize: 'Original dimensions',
        title: 'Codex subscriptions', registered: 'Registered accounts', add: 'Add account', removeAll: 'Sign out all accounts',
        browser: 'Browser sign-in', device: 'Device code sign-in', empty: 'No registered accounts', loading: 'Loading…',
        edit: 'Edit suffix', suffix: 'Account suffix', save: 'Save', remove: 'Remove', renew: 'Sign in again', cancel: 'Cancel',
        images: 'Image generation', imagesEnable: 'Enable image generation', imagesHint: 'Changes are saved and applied automatically. The 2.5 models are experimental; availability depends on your subscription.',
        imagesModel: 'Image model', imagesQuality: 'Quality', imagesAccount: 'Account', imagesAuto: 'Automatic',
        imagesMissingAccount: 'Selected account is no longer registered', imagesSaving: 'Applying…', imagesSaved: 'Image settings applied.', retry: 'Retry',
        qualityAuto: 'Auto', qualityLow: 'Low', qualityMedium: 'Medium', qualityHigh: 'High', qualityXhigh: 'Extra high', qualityMax: 'Maximum',
        valid: 'Authenticated', 'refresh-needed': 'Refresh needed', noEmail: 'Email unavailable',
        statusHint: 'Local token status; no quota or remote authentication query is performed.',
        confirm: 'Remove this account’s saved credentials and provider?', confirmAll: 'Remove all accounts registered in this plugin? The original subscription plugin is not affected.',
        yes: 'Confirm removal', yesAll: 'Sign out all', open: 'Open sign-in page', code: 'Device code', answer: 'Authorization response', submit: 'Continue',
        finalizing: 'Saving account…', starting: 'Starting sign-in…', waiting_browser: 'Complete sign-in in the browser.', waiting_device: 'Enter the device code on the sign-in page.',
        waiting_input: 'Complete browser sign-in, or paste the callback URL/code below.', failed: 'Sign-in failed', error: 'Could not complete the operation.',
      },
      zh: {
        imagePreparing: '正在准备图片请求…', imageWorking: '正在生成图片…', imageReady: '图片已生成', imageFailed: '图片不可用，请查看详情', imageOriginal: '打开已保存文件', imageDetails: '技术详情', imageAttachments: '附件信息', imagePreview: '图片预览', imageSavedFile: '已保存文件', imagePreviewSize: '预览尺寸', imageOriginalSize: '原图尺寸',
        title: 'Codex 订阅', registered: '已登录账号', add: '添加账号', removeAll: '退出全部账号',
        browser: '浏览器登录', device: '设备代码登录', empty: '暂无已登录账号', loading: '加载中…',
        edit: '修改后缀', suffix: '账号后缀', save: '保存', remove: '移除', renew: '重新登录', cancel: '取消',
        images: '图像生成', imagesEnable: '启用图像生成', imagesHint: '修改后自动保存并生效。2.5 模型为实验选项，能否使用取决于订阅权限。',
        imagesModel: '图像模型', imagesQuality: '质量', imagesAccount: '账号', imagesAuto: '自动选择',
        imagesMissingAccount: '所选账号已不再登录', imagesSaving: '正在应用…', imagesSaved: '图像设置已生效。', retry: '重试',
        qualityAuto: '自动', qualityLow: '低', qualityMedium: '中', qualityHigh: '高', qualityXhigh: '超高', qualityMax: '最高',
        valid: '认证有效', 'refresh-needed': '待刷新', noEmail: '未提供邮箱',
        statusHint: '依据本地令牌有效期显示，不查询额度或发送远程认证检查。',
        confirm: '移除此账号保存的凭据和 provider？', confirmAll: '退出本插件登记的全部账号？不会影响原订阅插件中的账号。',
        yes: '确认移除', yesAll: '确认退出全部账号', open: '打开登录页面', code: '设备码', answer: '授权响应', submit: '继续',
        finalizing: '正在保存账号…', starting: '正在开始登录…', waiting_browser: '请在浏览器中完成登录。', waiting_device: '请在登录页面输入设备码。',
        waiting_input: '在浏览器中完成登录，或在下方粘贴回调 URL / 授权码。', failed: '登录失败', error: '操作失败，请重试。',
      },
    }
    const css = `
      .csm{max-width:840px;padding:24px;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
      .csm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:20px;background:var(--dsw-alias-bg-layer-1)}
      .csm-header,.csm-row,.csm-flex{display:flex;align-items:center;gap:10px}.csm-header{justify-content:space-between;padding-bottom:16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
      .csm-header h3{margin:0;font-size:14px;font-weight:600}.csm-flex{flex-wrap:wrap}.csm-row{justify-content:space-between;padding:18px 0;gap:16px}
      .csm-identity{min-width:0;flex:1}.csm-name{font-size:15px;font-weight:600;overflow-wrap:anywhere;display:flex;align-items:center;gap:7px}
      .csm-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-top:6px}
      .csm-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.csm-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}.csm-dot-warn{background:var(--dsw-alias-state-warn-primary)}
      .csm-email{font-size:12px;font-weight:400;overflow-wrap:anywhere}.csm p{line-height:1.6;color:var(--dsw-alias-label-secondary);margin:8px 0}
      .csm input,.csm button,.csm select{font:inherit;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);padding:8px 12px;background:var(--dsw-alias-bg-layer-1);color:inherit;max-width:100%;box-sizing:border-box}
      .csm input{min-width:0}.csm button{cursor:pointer;white-space:nowrap}.csm button:disabled{opacity:.5;cursor:default}
      .csm :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.csm button.csm-edit{border:0;background:none;padding:3px;display:inline-flex;color:var(--dsw-alias-label-secondary)}
      .csm .csm-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
      .csm .csm-error,.csm .csm-danger{color:var(--dsw-alias-state-error-primary)}
      .csm-panel{background:var(--dsw-alias-bg-layer-2);padding:14px;border-radius:10px;margin-top:14px}.csm-confirm{width:100%;margin-top:10px}
      .csm .csm-edit-name{display:inline-flex;align-items:center;gap:0;box-sizing:border-box;height:34px;width:190px;max-width:100%;margin:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px;transition:border-color .15s,box-shadow .15s;cursor:text}
      .csm .csm-edit-name:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
      .csm .csm-edit-name span{flex:none;font-weight:600;line-height:inherit;white-space:nowrap}
      .csm .csm-edit-name input{flex:1;width:0;min-width:0;max-width:100%;height:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;font:inherit;font-weight:600;line-height:inherit;outline:none;box-shadow:none;appearance:none}
      .csm .csm-edit-name input:focus,.csm .csm-edit-name input:focus-visible{border:0;outline:none;outline-offset:0;box-shadow:none}
      .csm a{color:var(--dsw-alias-brand-primary)}
      .csm-images{margin-top:16px}
      .csm-images-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.csm-images h3{margin:0;font-size:14px;font-weight:600}
      .csm-images-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px;margin:12px 0}
      .csm-images-fields label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
      .csm-images-fields select{width:100%;color:var(--dsw-alias-label-primary)}.csm-images p{font-size:12px}
      .csm .csm-switch{display:inline-flex;align-items:center;width:34px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l2);flex:none}
      .csm .csm-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
      .csm-switch span{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base)}
      .csm-switch[aria-checked=true] span{transform:translateX(14px)}
      .csm-response{flex:1;min-width:140px!important}.csm-actions{display:flex;gap:8px;flex-wrap:wrap}.csm-row-wrap{border-bottom:1px solid var(--dsw-alias-border-l1)}.csm-row-wrap:last-child{border-bottom:0}
      @media(max-width:540px){.csm{padding:14px}.csm-card{padding:14px}.csm-header{align-items:flex-start}.csm-row{align-items:flex-start}.csm-meta{gap:6px 10px}}
    `
    function SubscriptionIcon({ size = 16 }) {
      // ChatGPT knot mark: https://commons.wikimedia.org/wiki/File:ChatGPT_logo.svg
      const d = 'M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z'
      return h('svg', { width: size, height: size, viewBox: '250 250 1906 1906', fill: 'currentColor', 'aria-hidden': true },
        [0, 60, 120, 180, 240, 300].map(angle => h('path', { key: angle, d, transform: `rotate(${angle} 1203 1203)` })))
    }
    function EditIcon() {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z' }))
    }
    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        const t = ctx.locale.bind(NS)
        const call = async input => {
          const result = await ctx.get('connection').rpc.call('/api', 'codex-subscribe/manage', input)
          if (!result?.ok) throw new Error(result?.error?.message || t('error'))
          return result.value
        }
        const isActive = login => login && !['authenticated', 'failed', 'cancelled'].includes(login.phase)
        function Section() {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot())
          const [accounts, setAccounts] = React.useState(null)
          const [adding, setAdding] = React.useState(false)
          const [renewId, setRenewId] = React.useState(null)
          const [login, setLogin] = React.useState(null)
          const [answer, setAnswer] = React.useState('')
          const [error, setError] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [confirmAll, setConfirmAll] = React.useState(false)
          const active = !!isActive(login)
          const reload = async () => {
            const value = await call({ action: 'list' })
            setAccounts(value.accounts)
            setLogin(value.login ?? null)
          }
          React.useEffect(() => {
            let stopped = false
            const load = () => call({ action: 'list' }).then(value => {
              if (!stopped) { setAccounts(value.accounts); setLogin(value.login ?? null) }
            }).catch(e => { if (!stopped) setError(e.message) })
            void load()
            window.addEventListener('focus', load)
            return () => { stopped = true; window.removeEventListener('focus', load) }
          }, [])
          React.useEffect(() => {
            if (!active) return
            let stopped = false, timer
            const poll = async () => {
              try {
                const view = await call({ action: 'login-status', id: login.id })
                if (stopped) return
                setLogin(view)
                if (view.phase === 'authenticated') {
                  const value = await call({ action: 'list' })
                  if (!stopped) { setAccounts(value.accounts); setAdding(false); setRenewId(null) }
                }
              } catch (e) { if (!stopped) setError(e.message) }
              if (!stopped) timer = setTimeout(poll, 1200)
            }
            timer = setTimeout(poll, 400)
            return () => { stopped = true; clearTimeout(timer) }
          }, [login?.id, active])
          const run = async operation => {
            setBusy(true); setError('')
            try { await operation() } catch (e) { setError(e.message || t('error')) } finally { setBusy(false) }
          }
          const start = method => run(async () => {
            setAnswer('')
            setLogin(await call({ action: 'login', method, ...(renewId ? { renewId } : {}) }))
            setAdding(false)
          })
          const openRenew = id => { setRenewId(id); setLogin(null); setAdding(true); setConfirmAll(false) }
          const count = accounts?.length ?? 0
          return h('section', { className: 'csm' }, h('style', null, css), h('div', { className: 'csm-card' },
            h('div', { className: 'csm-header' }, h('h3', null, t('registered')),
              h('div', { className: 'csm-actions' },
                h('button', { disabled: busy || active, onClick: () => { setRenewId(null); setLogin(null); setAdding(true); setConfirmAll(false) } }, t('add')),
                h('button', { disabled: busy || active || !count, onClick: () => { setConfirmAll(true); setAdding(false) } }, t('removeAll')))),
            error && h('p', { role: 'alert', className: 'csm-error' }, error),
            confirmAll && h('div', { className: 'csm-panel', role: 'group', 'aria-label': t('removeAll') },
              h('p', null, t('confirmAll')), h('div', { className: 'csm-actions' },
                h('button', { className: 'csm-danger', disabled: busy, onClick: () => run(async () => { await call({ action: 'remove-all' }); setConfirmAll(false); await reload() }) }, t('yesAll')),
                h('button', { disabled: busy, onClick: () => setConfirmAll(false) }, t('cancel')))),
            accounts === null ? h('p', null, t('loading')) : count === 0 ? h('p', null, t('empty')) : accounts.map(account => h(AccountRow, { key: account.id, account, multiple: count > 1, t, call, reload, run, busy, active, openRenew })),
            adding && !active && h('div', { className: 'csm-panel csm-flex' },
              h('button', { className: 'csm-primary', disabled: busy, onClick: () => start('browser') }, t('browser')),
              h('button', { disabled: busy, onClick: () => start('device_code') }, t('device')),
              h('button', { disabled: busy, onClick: () => { setAdding(false); setRenewId(null) } }, t('cancel'))),
            (active || login?.phase === 'failed') && h('div', { className: 'csm-panel', role: 'status' },
              h('p', null, t(login.phase)), login.error && h('p', { className: 'csm-error' }, login.error),
              login.authUrl && h('a', { href: login.authUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open')),
              login.userCode && h('p', null, t('code'), ': ', h('strong', null, login.userCode)),
              login.prompt && h('div', null, h('p', null, login.prompt.message), h('div', { className: 'csm-flex' },
                h('input', { className: 'csm-response', 'aria-label': t('answer'), type: 'password', value: answer, autoComplete: 'off', onChange: e => setAnswer(e.target.value) }),
                h('button', { disabled: busy || !answer.trim(), onClick: () => run(async () => { setLogin(await call({ action: 'login-submit', id: login.id, value: answer })); setAnswer('') }) }, t('submit')))),
              h('button', { disabled: busy || login.phase === 'finalizing', onClick: () => run(async () => { if (active) await call({ action: 'login-cancel', id: login.id }); setLogin(null); setRenewId(null); setAnswer('') }) }, t('cancel')))),
            h(ImageSettings, { accounts, t }))
        }
        function ImageSettings({ accounts, t }) {
          const [settings, setSettings] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          const [saved, setSaved] = React.useState(false)
          const [attempt, setAttempt] = React.useState(0)
          const saving = React.useRef(false)
          React.useEffect(() => {
            let stopped = false
            setError('')
            call({ action: 'images-settings' }).then(value => {
              if (!stopped) setSettings(value)
            }).catch(e => { if (!stopped) setError(e.message || t('error')) })
            return () => { stopped = true }
          }, [attempt])
          const update = async patch => {
            if (saving.current || !settings || accounts === null) return
            saving.current = true
            const previous = settings
            const next = { ...settings, ...patch }
            setSettings(next); setBusy(true); setSaved(false); setError('')
            try {
              const value = await call({ action: 'images-settings-save', settings: next })
              setSettings(value); setSaved(true)
            } catch (e) {
              setSettings(previous); setError(e.message || t('error'))
            } finally { saving.current = false; setBusy(false) }
          }
          const qualities = settings?.model.startsWith('gpt-image-2.5-') ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'low', 'medium', 'high']
          const missingAccount = settings?.accountId && accounts !== null && !accounts.some(account => account.id === settings.accountId)
          return h('section', { className: 'csm-card csm-images', 'aria-label': t('images'), 'aria-busy': busy },
            h('div', { className: 'csm-images-heading' }, h('h3', null, t('images')),
              h('button', { type: 'button', className: 'csm-switch', role: 'switch', 'aria-label': t('imagesEnable'), 'aria-checked': !!settings?.enabled,
                disabled: !settings || busy || accounts === null, onClick: () => update({ enabled: !settings.enabled }) }, h('span', { 'aria-hidden': true }))),
            h('p', null, t('imagesHint')),
            !settings ? (error ? h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, t('retry')) : h('p', { role: 'status' }, t('loading'))) : h(React.Fragment, null,
              h('div', { className: 'csm-images-fields' },
                h('label', null, t('imagesModel'), h('select', { value: settings.model, disabled: busy || accounts === null, onChange: e => {
                  const model = e.target.value
                  return update({ model, quality: model === 'gpt-image-2' && ['xhigh', 'max'].includes(settings.quality) ? 'auto' : settings.quality })
                } }, ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].map(model => h('option', { key: model, value: model }, model)))),
                h('label', null, t('imagesQuality'), h('select', { value: settings.quality, disabled: busy || accounts === null, onChange: e => update({ quality: e.target.value }) },
                  qualities.map(quality => h('option', { key: quality, value: quality }, t(`quality${quality[0].toUpperCase()}${quality.slice(1)}`))))),
                h('label', null, t('imagesAccount'), h('select', { value: settings.accountId, disabled: busy || accounts === null, onChange: e => update({ accountId: e.target.value }) },
                  h('option', { value: '' }, t('imagesAuto')),
                  missingAccount && h('option', { value: settings.accountId, disabled: true }, t('imagesMissingAccount')),
                  (accounts || []).map(account => h('option', { key: account.id, value: account.id }, account.email ? `${account.label} · ${account.email}` : account.label))))),
              (busy || saved) && h('p', { role: 'status' }, busy ? t('imagesSaving') : t('imagesSaved'))),
            error && h('p', { role: 'alert', className: 'csm-error' }, error))
        }
        function AccountRow({ account, multiple, t, call, reload, run, busy, active, openRenew }) {
          const [draft, setDraft] = React.useState(account.suffix)
          const [editing, setEditing] = React.useState(false)
          const [confirm, setConfirm] = React.useState(false)
          const [now, setNow] = React.useState(Date.now)
          React.useEffect(() => { setDraft(account.suffix) }, [account.suffix])
          React.useEffect(() => { if (!multiple) setEditing(false) }, [multiple])
          React.useEffect(() => {
            const remaining = account.expiresAt - Date.now()
            if (remaining <= 0) { setNow(Date.now()); return }
            const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 20, 2147483647))
            return () => clearTimeout(timer)
          }, [account.expiresAt])
          const status = account.expiresAt > now ? 'valid' : 'refresh-needed'
          const disabled = busy || active
          const save = () => run(async () => { await call({ action: 'rename', id: account.id, label: draft }); setEditing(false); await reload() })
          return h('div', { className: 'csm-row-wrap' }, h('div', { className: 'csm-row' },
            h('div', { className: 'csm-identity' },
              editing ? h('form', { className: 'csm-flex', onSubmit: e => { e.preventDefault(); if (!disabled && draft.trim()) void save() } },
                h('label', { className: 'csm-edit-name' }, h('span', null, 'Codex-'), h('input', { 'aria-label': t('suffix'), value: draft, maxLength: 32, pattern: '[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}', autoFocus: true, disabled, onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setDraft(account.suffix) } } })),
                h('button', { type: 'submit', disabled: disabled || !draft.trim() }, t('save')),
                h('button', { type: 'button', disabled: busy, onClick: () => { setEditing(false); setDraft(account.suffix) } }, t('cancel')))
              : h('div', { className: 'csm-name' }, account.label,
                multiple && h('button', { className: 'csm-edit', 'aria-label': t('edit'), title: t('edit'), disabled, onClick: () => { setEditing(true); setConfirm(false) } }, h(EditIcon))),
              h('div', { className: 'csm-meta' },
                h('span', { className: 'csm-status', title: t('statusHint') }, h('span', { className: `csm-dot${status === 'valid' ? '' : ' csm-dot-warn'}`, 'aria-hidden': true }), t(status)),
                h('span', { className: 'csm-email' }, account.email || t('noEmail')))),
            h('div', { className: 'csm-actions' },
              status !== 'valid' && h('button', { disabled, onClick: () => openRenew(account.id) }, t('renew')),
              h('button', { disabled, onClick: () => { setConfirm(true); setEditing(false) } }, t('remove')))),
            confirm && h('div', { className: 'csm-confirm', role: 'group', 'aria-label': t('remove') }, h('p', null, t('confirm')),
              h('div', { className: 'csm-actions' }, h('button', { className: 'csm-danger', disabled, onClick: () => run(async () => { await call({ action: 'remove', id: account.id }); await reload() }) }, t('yes')),
                h('button', { disabled: busy, onClick: () => setConfirm(false) }, t('cancel')))))
        }
        function ImageResult(p) {
          // The native Hook resets both disclosures when their enclosing Turn
          // collapses, so reopening a Turn never remounts a stale large preview.
          const { expanded: previewOpen, setExpanded: setPreviewOpen } = p.useDisclosure()
          const { expanded: detailsOpen, setExpanded: setDetailsOpen } = p.useDisclosure()
          const settled = p.phase === 'result'
          const content = settled && Array.isArray(p.block.content) ? p.block.content : []
          const texts = content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
          const images = p.block.isError ? [] : content.filter(b => b.type === 'image' && typeof b.attachment?.attachmentId === 'string' && b.attachment.attachmentId && /^image\//.test(b.attachment.mediaType) && Number.isSafeInteger(b.attachment.bytes) && b.attachment.bytes > 0 && Number.isSafeInteger(b.attachment.width) && b.attachment.width > 0 && Number.isSafeInteger(b.attachment.height) && b.attachment.height > 0).map(b => ({ attachment: b.attachment }))
          // Paths are JSON strings, never HTML or Markdown. Prefer a user-selected
          // saved copy, while still understanding historical Host-file-only results.
          const readPath = label => {
            for (const line of texts.split(/\r?\n/)) {
              if (!line.startsWith(`${label}: `)) continue
              try {
                const value = JSON.parse(line.slice(label.length + 2))
                if (typeof value === 'string' && value.trim()) return value
              } catch {}
            }
          }
          const path = readPath('Saved file') || readPath('Host file')
          const warning = texts.match(/^Warning: [\s\S]*/m)?.[0]
          const attachments = content.filter(b => b.type !== 'text')
          const hasOriginal = attachments.some(b => b.type === 'file' && typeof b.attachment?.attachmentId === 'string' && b.attachment.attachmentId.trim())
          const failed = settled && (p.block.isError || (!images.length && !path && !hasOriginal))
          const summaryStyle = { cursor: 'pointer', fontSize: 13 }
          const preStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }
          const dimensions = value => Number.isSafeInteger(value?.width) && value.width > 0 && Number.isSafeInteger(value?.height) && value.height > 0 ? `${value.width} × ${value.height}` : ''
          return h('div', { style: { color: 'var(--dsw-alias-label-primary)', maxWidth: '100%' } },
            h('div', { role: 'status', style: { color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)', fontSize: 13, padding: '6px 0' } }, `${p.toolName} · ${t(p.phase === 'preparing' ? 'imagePreparing' : !settled ? 'imageWorking' : failed ? 'imageFailed' : 'imageReady')}`),
            warning && h('p', { role: 'alert', style: { ...preStyle, color: 'var(--dsw-alias-state-warn-primary)' } }, warning),
            path && h('div', { style: { fontSize: 12, overflowWrap: 'anywhere' } },
              h('span', { title: path }, `${t('imageSavedFile')}: ${path.split(/[\\/]/).pop() || path}`), ' · ',
              h('button', { type: 'button', onClick: () => p.openFile(path), style: { font: 'inherit', color: 'var(--dsw-alias-brand-primary)', background: 'none', border: 0, cursor: 'pointer', padding: '4px 0' } }, t('imageOriginal'))),
            images.map(({ attachment }, index) => h('div', { key: index, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              `${t('imagePreviewSize')}: ${dimensions(attachment)}`,
              dimensions(attachment.originalDimensions) && ` · ${t('imageOriginalSize')}: ${dimensions(attachment.originalDimensions)}`)),
            images.length > 0 && h('details', { open: previewOpen, onToggle: event => {
              if (event.target === event.currentTarget) setPreviewOpen(event.currentTarget.open)
            } }, h('summary', { style: summaryStyle }, t('imagePreview')),
              // A closed disclosure alone still mounts its children. Gate the slot
              // itself so compact views cannot briefly flash or fetch a large image.
              previewOpen && p.renderFactorySlot('conversation.images.content', { images, loadImage: p.loadImage, align: 'start' })),
            (texts || attachments.length > 0) && h('details', { open: detailsOpen, onToggle: event => {
              if (event.target === event.currentTarget) setDetailsOpen(event.currentTarget.open)
            } },
              h('summary', { style: summaryStyle }, t('imageDetails')),
              texts && h('pre', { style: preStyle }, texts),
              attachments.length > 0 && h('div', null, h('div', { style: { fontSize: 12 } }, t('imageAttachments')), h('pre', { style: preStyle }, JSON.stringify(attachments, null, 2)))))
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'codex_image_generate' }, ImageResult))
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'codex-subscribe', order: 16, label: () => t('title') }, Section))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'codex-subscribe' }, SubscriptionIcon))
      },
    }
  },
})
