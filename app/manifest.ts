import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '飞书 → 雪球发布助手',
    short_name: '雪球发布助手',
    description: '从飞书消息生成有来源、可审核的雪球财经动态草稿。',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf7f1',
    theme_color: '#4a3b2b',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    share_target: {
      action: '/?source=ios-share',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  } as MetadataRoute.Manifest;
}
