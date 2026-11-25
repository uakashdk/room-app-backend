import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';
import type { AuthedUser } from '../middleware/authenticate';

/**
 * The art of a VIP level, one picture each. They are saved one per document in vip_levels/<id>/assets/<kind>
 * (so the VIP list the whole app listens to stays small; a picture is read only when somebody needs it).
 *   banner   - the big hanging banner / emblem on the VIP screen
 *   ornament - the decorative border above "Privilege Effect"
 *   entrance - the banner that slides in a room when this VIP enters ("Entrance show")
 *   card     - the background of the profile card ("Distinguished card")
 *   bubble   - the stretchable chat bubble in rooms
 */
export const VIP_ASSET_KINDS = ['banner', 'ornament', 'entrance', 'card', 'bubble'] as const;
export type VipAssetKind = (typeof VIP_ASSET_KINDS)[number];

const auditRef = () => db.collection('admin_logs').doc();

export async function setVipAsset(actor: AuthedUser, levelId: string, kind: VipAssetKind, data: string): Promise<void> {
  const level = db.doc(`vip_levels/${levelId}`);
  if (!(await level.get()).exists) throw new AppError(404, 'not-found', 'This VIP level does not exist.');
  const batch = db.batch();
  batch.set(level.collection('assets').doc(kind), { data, bytes: data.length, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
  batch.create(auditRef(), {
    actorUid: actor.uid, actorName: actor.name, action: 'set_vip_asset', collection: 'vip_levels', targetId: levelId,
    details: { kind, bytes: data.length }, at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

export async function removeVipAsset(actor: AuthedUser, levelId: string, kind: VipAssetKind): Promise<void> {
  const level = db.doc(`vip_levels/${levelId}`);
  if (!(await level.get()).exists) throw new AppError(404, 'not-found', 'This VIP level does not exist.');
  const batch = db.batch();
  batch.delete(level.collection('assets').doc(kind));
  batch.create(auditRef(), {
    actorUid: actor.uid, actorName: actor.name, action: 'remove_vip_asset', collection: 'vip_levels', targetId: levelId,
    details: { kind }, at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}
