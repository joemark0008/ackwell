import type { Channel } from '@ackwell/schemas';
import { Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ApiError } from '@/lib/api';
import { useDeleteChannel } from '@/lib/queries';

export function DeleteChannelDialog({
  channel,
  open,
  onOpenChange,
  redirectTo,
}: {
  channel: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirectTo?: string;
}) {
  const del = useDeleteChannel();
  const navigate = useNavigate();

  async function onConfirm(e: React.MouseEvent) {
    e.preventDefault();
    try {
      await del.mutateAsync(channel.id);
      toast.success(`Deleted “${channel.name}”`);
      onOpenChange(false);
      if (redirectTo) navigate(redirectTo);
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'CHANNEL_RUNNING' ? 'Stop the channel before deleting it.' : 'Delete failed.');
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{channel.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the channel and its whole message log. Senders and receivers using it will stop working. This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} disabled={del.isPending}>
            {del.isPending && <Loader2 className="animate-spin" />}
            Delete channel
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
