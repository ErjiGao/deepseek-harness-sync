/**
 * The browser half of `deepseek-harness-sync`.
 *
 * This file **is** the served client bundle: the host reads `exports["./client"]`
 * and hands the bytes to the browser verbatim, so there is no build step and no
 * bundler. That dictates two rules this file follows:
 *
 * - no JSX and no ESM syntax — the loader calls the factory with a synchronous
 *   CommonJS `require`, and only the platform baseline (React among it) is
 *   resolvable;
 * - everything lives inside the factory closure, because executing the bundle
 *   only registers the factory.
 *
 * The page talks to the host over the private loopback route prefix the host half
 * registers (`lib/host/api.js`), so opening Settings never needs a terminal.
 *
 * @module deepseek-harness-sync/client
 */

window.__ModuleLoader__.load({
	id: 'deepseek-harness-sync',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require('react');

		/** Route prefix claimed by the host half. */
		const API = '/harness-sync/api';

		/** Longest a single host call may take before the page gives up waiting. */
		const REQUEST_TIMEOUT_MS = 180000;

		const h = React.createElement;

		/**
		 * Styling uses the theme's own alias tokens, each with a neutral fallback,
		 * so the page matches light/dark and any third-party theme without knowing
		 * which one is active. Unfilled controls always inherit the foreground.
		 */
		const T = {
			font: 'var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)',
			size: 'var(--dsw-font-s-14-font-size, 14px)',
			small: 'var(--dsw-font-xs-13-font-size, 13px)',
			tiny: 'var(--dsw-font-xxs-12-font-size, 12px)',
			mono: 'var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
			border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
			borderStrong: 'var(--dsw-alias-border-l3, rgba(128,128,128,0.45))',
			raised: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
			// A filled button needs BOTH halves of the pair. The primary fill resolves
			// to the brand colour (#0f1115 here — near-black), so leaving the label at
			// `inherit` painted dark text onto a dark fill: an unreadable black block.
			// `--dsw-alias-label-primary-inverted` is the token the theme pairs with it.
			primaryFill: 'var(--dsw-alias-button-primary-fill, #0f1115)',
			onPrimary: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
			radius: 'var(--dsw-corner-shape, 8px)',
		};

		/**
		 * Call the host bridge.
		 *
		 * @param {string} action - the endpoint name.
		 * @param {object} [body] - a JSON body; omitted for GETs.
		 * @returns {Promise<object>} the parsed response.
		 */
		async function request(action, body) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await fetch(`${API}/${action}`, body === undefined
					? { signal: controller.signal }
					: {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
						signal: controller.signal,
					});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(payload.error || `host returned HTTP ${response.status}`);
				return payload;
			} catch (error) {
				if (error && error.name === 'AbortError') throw new Error('the host did not answer in time');
				throw error;
			} finally {
				clearTimeout(timer);
			}
		}

		/**
		 * Ask the browser to save a snapshot the host just wrote.
		 *
		 * The download endpoint streams the file with an attachment disposition, so
		 * this really lands in the browser's download folder — the host has already
		 * written its own copy under the plugin's data directory as well.
		 *
		 * @param {string} name - the snapshot file name.
		 */
		function downloadSnapshot(name) {
			if (typeof document === 'undefined') return;
			const link = document.createElement('a');
			link.href = `${API}/download?name=${encodeURIComponent(name)}`;
			link.download = name;
			link.rel = 'noopener';
			document.body.append(link);
			link.click();
			link.remove();
		}

		/**
		 * A button that reflects the busy state.
		 *
		 * @param {{label: string, onClick: Function, busy: string, disabled?: boolean, primary?: boolean, title?: string}} props - the button.
		 * @returns {object} a React element.
		 */
		function Button(props) {
			const active = props.busy === props.label;
			const disabled = props.disabled === true || props.busy !== '';
			return h('button', {
				type: 'button',
				title: props.title,
				disabled,
				onClick: props.onClick,
				style: {
					font: 'inherit',
					fontSize: T.small,
					fontWeight: props.primary === true ? 600 : 400,
					color: props.primary === true ? T.onPrimary : 'inherit',
					background: props.primary === true ? T.primaryFill : 'transparent',
					border: `1px solid ${props.primary === true ? T.primaryFill : T.borderStrong}`,
					borderRadius: T.radius,
					padding: props.primary === true ? '8px 16px' : '7px 13px',
					cursor: disabled ? 'default' : 'pointer',
					opacity: disabled && !active ? 0.5 : 1,
					whiteSpace: 'nowrap',
				},
			}, active ? `${props.label}…` : props.label);
		}

		/**
		 * One label/value line.
		 *
		 * @param {{label: string, value: unknown, mono?: boolean}} props - the row.
		 * @returns {object} a React element.
		 */
		function Row(props) {
			return h('div', {
				style: { display: 'flex', gap: '12px', alignItems: 'baseline', padding: '3px 0' },
			}, [
				h('span', {
					key: 'l',
					style: { fontSize: T.small, opacity: 0.62, minWidth: '132px', flex: '0 0 auto' },
				}, props.label),
				h('span', {
					key: 'v',
					style: {
						fontSize: T.small,
						fontFamily: props.mono === true ? T.mono : 'inherit',
						wordBreak: 'break-all',
					},
				}, String(props.value === undefined || props.value === null || props.value === '' ? '—' : props.value)),
			]);
		}

		/**
		 * A short status pill.
		 *
		 * @param {{tone: 'ok'|'warn'|'bad'|'idle', text: string}} props - the pill.
		 * @returns {object} a React element.
		 */
		function Pill(props) {
			const tint = { ok: '#2ea043', warn: '#d29922', bad: '#f85149', idle: 'rgba(128,128,128,0.6)' }[props.tone];
			return h('span', {
				style: {
					display: 'inline-block',
					fontSize: T.tiny,
					padding: '2px 9px',
					borderRadius: '999px',
					border: `1px solid ${tint}`,
					color: 'inherit',
					whiteSpace: 'nowrap',
				},
			}, h('span', {
				style: {
					display: 'inline-block',
					width: '7px',
					height: '7px',
					borderRadius: '50%',
					background: tint,
					marginRight: '6px',
					verticalAlign: 'middle',
				},
			}), props.text);
		}

		/**
		 * Map a verdict to a pill.
		 *
		 * @param {string} verdict - the verdict code.
		 * @param {boolean} remoteChecked - whether the remote was consulted.
		 * @returns {{tone: 'ok'|'warn'|'bad'|'idle', text: string}} the pill.
		 */
		function verdictPill(verdict, remoteChecked) {
			if (!remoteChecked) return { tone: 'idle', text: '仅本地' };
			if (verdict === 'synchronized') return { tone: 'ok', text: '已同步' };
			if (verdict === 'local-ahead' || verdict === 'local-only' || verdict === 'local-not-checked') return { tone: 'warn', text: '本地有未上传改动' };
			if (verdict === 'remote-ahead') return { tone: 'warn', text: '仓库更新' };
			if (verdict === 'diverged') return { tone: 'bad', text: '已分叉' };
			if (verdict === 'unreachable') return { tone: 'bad', text: '仓库不可达' };
			return { tone: 'idle', text: verdict };
		}

		/**
		 * The Settings page itself.
		 *
		 * @returns {object} a React element.
		 */
		function Section() {
			const [status, setStatus] = React.useState(undefined);
			const [failure, setFailure] = React.useState('');
			const [busy, setBusy] = React.useState('');
			const [output, setOutput] = React.useState('');
			const [url, setUrl] = React.useState('');
			const [branch, setBranch] = React.useState('main');
			const [advanced, setAdvanced] = React.useState(false);
			const [showFiles, setShowFiles] = React.useState(false);

			const load = React.useCallback(async (withRemote) => {
				try {
					const data = await request(withRemote === true ? 'status?remote=1' : 'status');
					setStatus(data);
					setFailure('');
				} catch (error) {
					setFailure(error && error.message ? error.message : String(error));
				}
			}, []);

			// First paint is local-only so opening Settings never waits on the
			// network; the remote half is then asked for in the background.
			React.useEffect(() => {
				load(false).then(() => load(true));
			}, [load]);

			const run = React.useCallback(async (action, body, label) => {
				setBusy(label || action);
				setOutput('');
				try {
					const result = await request(action, body);
					setOutput(result.output || `exit ${result.exitCode}`);
				} catch (error) {
					setOutput(`出错：${error && error.message ? error.message : String(error)}`);
				} finally {
					setBusy('');
					await load(true);
				}
			}, [load]);

			// Export is two steps: the host writes the snapshot, then the browser saves
			// it. Kept separate from `run` so the download is driven by the structured
			// response rather than by parsing the printed text.
			const exportBackup = React.useCallback(async () => {
				setBusy('导出备份');
				setOutput('');
				try {
					const result = await request('export', {});
					setOutput(result.output || `exit ${result.exitCode}`);
					if (typeof result.name === 'string' && result.name !== '') {
						downloadSnapshot(result.name);
						setOutput(`${result.output}\n\n正在下载 ${result.name} —— 浏览器会把它存到下载目录，宿主机上也保留了一份。`);
					}
				} catch (error) {
					setOutput(`出错：${error && error.message ? error.message : String(error)}`);
				} finally {
					setBusy('');
					await load(true);
				}
			}, [load]);

			const children = [];

			children.push(h('div', { key: 'head', style: { marginBottom: '4px' } }, [
				h('div', { key: 't', style: { fontSize: 'var(--dsw-font-m-18-font-size, 17px)', fontWeight: 600 } }, '配置同步'),
				h('div', { key: 's', style: { fontSize: T.small, opacity: 0.66, marginTop: '4px' } },
					'通过你自己的 GitHub 私有仓库，在多台电脑之间同步 DeepSeek Harness 配置。'),
			]));

			if (failure !== '') {
				children.push(h('div', {
					key: 'fail',
					style: {
						marginTop: '14px',
						padding: '10px 12px',
						border: `1px solid ${T.border}`,
						borderRadius: T.radius,
						fontSize: T.small,
					},
				}, `无法连接宿主的同步服务：${failure}。若 DeepSeek Harness 未通过内建 Web 服务器运行（例如桌面版以 file:// 加载），此页面无法工作。`));
			}

			if (status === undefined) {
				children.push(h('div', { key: 'loading', style: { marginTop: '16px', fontSize: T.small, opacity: 0.7 } }, '正在读取状态…'));
				return h('div', { style: { fontFamily: T.font, fontSize: T.size, padding: '4px 2px' } }, children);
			}

			// ---------- not connected ----------
			if (status.initialized !== true) {
				children.push(h('div', { key: 'notinit', style: { marginTop: '16px' } }, [
					h('div', { key: 'h', style: { fontSize: T.small, fontWeight: 600, marginBottom: '6px' } }, '连接一个 GitHub 私有仓库'),
					h('div', { key: 'p', style: { fontSize: T.small, opacity: 0.7, marginBottom: '12px', lineHeight: 1.6 } }, [
						'先在 GitHub 上新建一个 ',
						h('strong', { key: 'b' }, 'Private'),
						' 仓库（建议命名 deepseek-harness-config，不要勾选 README）。仓库里会有你的机器名、插件清单和 settings.yaml，',
						h('strong', { key: 'b2' }, '必须是私有仓库'),
						'。',
					]),
					h('div', { key: 'f', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } }, [
						h('input', {
							key: 'url',
							type: 'text',
							value: url,
							placeholder: 'https://github.com/<你的账号>/deepseek-harness-config.git',
							onChange: (event) => setUrl(event.target.value),
							style: {
								font: 'inherit',
								fontSize: T.small,
								color: 'inherit',
								background: T.raised,
								border: `1px solid ${T.border}`,
								borderRadius: T.radius,
								padding: '7px 10px',
								minWidth: '320px',
								flex: '1 1 320px',
							},
						}),
						h('input', {
							key: 'branch',
							type: 'text',
							value: branch,
							placeholder: 'main',
							onChange: (event) => setBranch(event.target.value),
							style: {
								font: 'inherit',
								fontSize: T.small,
								color: 'inherit',
								background: T.raised,
								border: `1px solid ${T.border}`,
								borderRadius: T.radius,
								padding: '7px 10px',
								width: '110px',
							},
						}),
						h(Button, {
							key: 'go',
							label: '连接仓库',
							primary: true,
							busy,
							disabled: url.trim() === '',
							onClick: () => run('init', { url: url.trim(), branch: branch.trim() || 'main' }, '连接仓库'),
						}),
					]),
					h('div', { key: 'files', style: { marginTop: '14px', fontSize: T.tiny, opacity: 0.66 } },
						`连接后本机将被同步的文件：${(status.files || []).length} 个`),
					h('div', {
						key: 'list',
						style: { marginTop: '6px', fontFamily: T.mono, fontSize: T.tiny, opacity: 0.8, lineHeight: 1.7, wordBreak: 'break-all' },
					}, (status.files || []).map((file, index) => h('div', { key: index }, file))),
				]));
			}

			// ---------- connected ----------
			const pill = verdictPill(status.verdict, status.remoteChecked !== false);
			children.push(h('div', {
				key: 'pills',
				style: { marginTop: '14px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
			}, [
				h(Pill, { key: 'p', tone: pill.tone, text: pill.text }),
				h('span', { key: 'm', style: { fontSize: T.small, opacity: 0.7 } }, status.message || ''),
			]));

			children.push(h('div', {
				key: 'actions',
				style: { marginTop: '14px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
			}, [
				h(Button, {
					key: 'push',
					label: '上传到 GitHub',
					primary: true,
					busy,
					title: '把本机配置作为新版本提交并推送到私有仓库',
					onClick: () => run('push', {}, '上传到 GitHub'),
				}),
				h(Button, { key: 'pull', label: '拉取', busy, title: '应用仓库中的配置到本机（会先自动备份）', onClick: () => run('pull', {}, '拉取') }),
				h(Button, { key: 'sync', label: '一键同步', busy, title: '先比较两边，再决定上传还是拉取；分叉时不会擅自覆盖', onClick: () => run('sync', {}, '一键同步') }),
				h(Button, {
					key: 'export',
					label: '导出备份',
					busy,
					title: '把本机当前配置导出成一个快照文件，并保存到本机下载目录',
					onClick: exportBackup,
				}),
				h(Button, { key: 'refresh', label: '刷新', busy, onClick: () => load(true) }),
				h(Button, { key: 'adv', label: advanced ? '收起高级' : '高级', busy, onClick: () => setAdvanced(!advanced) }),
			]));

			if (advanced) {
				children.push(h('div', {
					key: 'advbox',
					style: { marginTop: '12px', padding: '12px', border: `1px solid ${T.border}`, borderRadius: T.radius },
				}, [
					h('div', { key: 'a', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
						h(Button, { key: 'dry', label: '预演上传', busy, title: '只报告会推送什么，不提交、不推送', onClick: () => run('push', { dryRun: true }, '预演上传') }),
						h(Button, { key: 'drypull', label: '预演拉取', busy, title: '只报告会写入什么，不写盘', onClick: () => run('pull', { dryRun: true }, '预演拉取') }),
						h(Button, { key: 'baks', label: '查看备份', busy, onClick: () => run('rollback', { list: true }, '查看备份') }),
						h(Button, {
							key: 'roll',
							label: '回滚最近一次',
							busy,
							title: '用最近一次自动备份还原本机配置',
							onClick: () => {
								if (typeof window !== 'undefined' && window.confirm('用最近一次备份还原本机配置？当前配置会先被再备份一份，所以这一步本身也可撤销。')) {
									run('rollback', {}, '回滚最近一次');
								}
							},
						}),
						h(Button, {
							key: 'force',
							label: '强制上传',
							busy,
							title: '即使仓库比你上次同步时更新，也仍然上传本机配置',
							onClick: () => {
								if (typeof window !== 'undefined' && window.confirm('仓库已前进过。强制上传会在仓库当前内容之上生成一个新版本（不会改写远端历史），继续？')) {
									run('push', { force: true }, '强制上传');
								}
							},
						}),
					]),
					(status.backups || []).length > 0 && h('div', { key: 'bl', style: { marginTop: '10px', fontFamily: T.mono, fontSize: T.tiny, opacity: 0.8, lineHeight: 1.7 } },
						status.backups.slice(0, 5).map((backup, index) => h('div', { key: index },
							`${backup.name}　v${backup.version}　${backup.fileCount} 个文件　${backup.reason || ''}`))),
				]));
			}

			children.push(h('div', {
				key: 'grid',
				style: { marginTop: '18px', borderTop: `1px solid ${T.border}`, paddingTop: '12px' },
			}, [
				h(Row, { key: 'r', label: '仓库', value: status.repoUrl, mono: true }),
				h(Row, { key: 'b', label: '分支', value: status.branch }),
				h(Row, { key: 'd', label: '本机设备名', value: status.device }),
				h(Row, { key: 'p', label: '配置档 (profile)', value: status.profile }),
				h(Row, { key: 'lv', label: '本地版本', value: status.localVersion }),
				h(Row, { key: 'rv', label: '远端版本', value: status.remoteChecked === false ? '尚未查询' : status.remoteVersion }),
				h(Row, { key: 'rs', label: '远端快照来自', value: status.remoteChecked === false ? undefined : status.remoteDevice }),
				h(Row, { key: 'la', label: '上次同步', value: status.lastSyncAt === '' ? '从未' : `${status.lastSyncAt}（${status.lastSyncKind || '—'}）` }),
				h(Row, { key: 'au', label: '认证方式', value: status.authentication }),
				h(Row, {
					key: 'pv',
					label: '仓库是否私有',
					value: status.privacy === 'yes' ? '已由 GitHub 确认为私有' : '未经校验 —— 请自行确认',
				}),
				h(Row, { key: 'fc', label: '同步文件数', value: (status.files || []).length }),
			]));

			if (status.fetchError) {
				children.push(h('div', {
					key: 'fetcherr',
					style: { marginTop: '10px', fontSize: T.small, opacity: 0.85, whiteSpace: 'pre-wrap', fontFamily: T.mono },
				}, status.fetchError));
			}

			if ((status.machineDeps || []).length > 0) {
				children.push(h('div', {
					key: 'deps',
					style: { marginTop: '12px', padding: '10px 12px', border: `1px solid ${T.border}`, borderRadius: T.radius, fontSize: T.tiny, lineHeight: 1.7 },
				}, [
					h('div', { key: 'h', style: { fontWeight: 600, marginBottom: '4px' } },
						`${status.machineDeps.length} 处依赖指向本机目录，换电脑后会失效`),
					h('div', { key: 'b', style: { opacity: 0.8 } }, '它们会被原样同步。到新电脑后需要重新安装该插件或删除对应条目，然后执行 pnpm install。'),
					h('div', { key: 'l', style: { fontFamily: T.mono, marginTop: '6px', opacity: 0.8, wordBreak: 'break-all' } },
						status.machineDeps.slice(0, 6).map((dep, index) => h('div', { key: index }, `${dep.rel}:${dep.line}  ${dep.spec}`))),
				]));
			}

			children.push(h('div', { key: 'togglefiles', style: { marginTop: '12px' } },
				h(Button, { label: showFiles ? '收起文件清单' : '显示文件清单', busy, onClick: () => setShowFiles(!showFiles) })));
			if (showFiles) {
				children.push(h('div', {
					key: 'files',
					style: { marginTop: '8px', fontFamily: T.mono, fontSize: T.tiny, opacity: 0.85, lineHeight: 1.75, wordBreak: 'break-all' },
				}, (status.files || []).map((file, index) => h('div', { key: index },
					(status.absent || []).indexOf(file) >= 0 ? `${file}（本机不存在）` : file))));
			}

			if (output !== '') {
				children.push(h('pre', {
					key: 'out',
					style: {
						marginTop: '16px',
						padding: '12px',
						border: `1px solid ${T.border}`,
						borderRadius: T.radius,
						background: T.raised,
						fontFamily: T.mono,
						fontSize: T.tiny,
						lineHeight: 1.65,
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						maxHeight: '320px',
						overflow: 'auto',
					},
				}, output));
			}

			return h('div', {
				style: { fontFamily: T.font, fontSize: T.size, padding: '4px 2px', maxWidth: '820px' },
			}, children);
		}

		const name = 'harness-sync-client';
		/** The slot registry is the only client service this page needs. */
		const inject = ['slots'];

		/**
		 * Contribute the Settings page.
		 *
		 * @param {object} ctx - the client cordis context.
		 */
		function apply(ctx) {
			// `slots.inject` waits for the slot type to be declared, so this page
			// appears whether or not the settings shell happened to load first.
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{
						name: 'settings.section',
						id: 'harness-sync',
						order: 60,
						label: () => '配置同步',
						inject: () => ({}),
					},
					Section,
				));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
