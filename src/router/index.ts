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
                    redirect: '/task/active',
                },
                {
                    path: '/task/:status?',
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
                            path: 'basic',
                            alias: '',
                            name: 'preference-basic',
                            component: () => import('@/components/preference/Basic.vue'),
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
