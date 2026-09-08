/** @fileoverview Vue Router configuration with task and preference routes. */
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      children: [
        {
          path: '',
          redirect: '/task/all',
        },
        {
          path: '/task/:status(all|progress|failed|completed)?',
          name: 'task',
          component: () => import('@/views/TaskView.vue'),
          props: true,
        },
        {
          path: '/preference',
          name: 'preference',
          component: () => import('@/views/PreferenceView.vue'),
          children: [
            {
              path: 'general',
              alias: '',
              name: 'preference-general',
              component: () => import('@/components/preference/General.vue'),
            },
            {
              path: 'downloads',
              name: 'preference-downloads',
              component: () => import('@/components/preference/Downloads.vue'),
            },
            {
              path: 'bt',
              name: 'preference-bt',
              component: () => import('@/components/preference/BitTorrent.vue'),
            },
            {
              path: 'ed2k',
              name: 'preference-ed2k',
              component: () => import('@/components/preference/Ed2k.vue'),
            },
            {
              path: 'network',
              name: 'preference-network',
              component: () => import('@/components/preference/Network.vue'),
            },
            {
              path: 'advanced',
              name: 'preference-advanced',
              component: () => import('@/components/preference/Advanced.vue'),
            },
          ],
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

export default router
