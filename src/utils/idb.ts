import { get, set } from 'idb-keyval';
import { Lead } from '../types';

export const getLeadsIDB = async (): Promise<Lead[] | null> => {
  try {
    // Implement race condition timeout to prevent IDB hanging forever in blocked iframes
    const leads = await Promise.race([
      get('all_leads'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('IDB Timeout')), 1000))
    ]);
    return (leads as Lead[]) || null;
  } catch (error) {
    console.error('getLeadsIDB error/timeout:', error);
    return null;
  }
};

export const setLeadsIDB = async (leads: Lead[]): Promise<void> => {
  try {
    // We clone the object to strip any React Proxies or frozen constraints 
    // that sometimes cause DataCloneError in IndexedDB
    const cloned = JSON.parse(JSON.stringify(leads));
    await Promise.race([
      set('all_leads', cloned),
      new Promise((_, reject) => setTimeout(() => reject(new Error('IDB Set Timeout')), 1000))
    ]);
  } catch (error) {
    console.error('setLeadsIDB error:', error);
  }
};
