import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { ChannelDetailPage } from '@/pages/channel-detail';
import { EditChannelPage, NewChannelPage } from '@/pages/channel-form';
import { ChannelsListPage } from '@/pages/channels-list';
import { NotFoundPage } from '@/pages/not-found';

export function createRouter(email: string) {
  return createBrowserRouter([
    {
      path: '/',
      element: <AppShell email={email} />,
      children: [
        { index: true, element: <Navigate to="/channels" replace /> },
        { path: 'channels', element: <ChannelsListPage /> },
        { path: 'channels/new', element: <NewChannelPage /> },
        { path: 'channels/:id', element: <ChannelDetailPage /> },
        { path: 'channels/:id/edit', element: <EditChannelPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}
