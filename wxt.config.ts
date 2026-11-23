import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: '课记：B站视频笔记',
    version: '0.1.0',
    minimum_chrome_version: '116',
    description: '从 B 站视频字幕与音轨生成带时间戳的课程笔记。',
    permissions: ['activeTab', 'scripting', 'storage', 'alarms', 'declarativeNetRequestWithHostAccess'],
    optional_permissions: ['offscreen'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    icons: {
      16: 'icons/keji-16.png',
      32: 'icons/keji-32.png',
      48: 'icons/keji-48.png',
      128: 'icons/keji-128.png',
    },
    action: {
      default_title: '课记课程工作区',
      default_icon: {
        16: 'icons/keji-16.png',
        32: 'icons/keji-32.png',
        48: 'icons/keji-48.png',
      },
    },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Ctrl+Shift+Y' },
      },
    },
  },
});
