// Local route storage in the browser's IndexedDB.
// Only the waypoints and profile are stored (small and re-routable),
// not the full calculated track.
import { openDB, type IDBPDatabase } from 'idb';

export interface SavedRoute {
  id?: number;
  name: string;
  waypoints: [number, number][];
  bike: string;
  traffic: number;
  distanceMeters: number;
  createdAt: string;
  /** Route returns to waypoint 1 (a closed loop). */
  closed?: boolean;
}

const DB_NAME = 'lightroute';
const STORE = 'routes';

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    },
  });
}

export async function saveRoute(route: SavedRoute): Promise<void> {
  await (await db()).add(STORE, route);
}

export async function listRoutes(): Promise<SavedRoute[]> {
  return (await (await db()).getAll(STORE)) as SavedRoute[];
}

export async function deleteRoute(id: number): Promise<void> {
  await (await db()).delete(STORE, id);
}
