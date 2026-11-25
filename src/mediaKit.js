const DATABASE = 'collab-pipeline-assets'
const STORE = 'files'
const KEY = 'media-kit'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function useStore(mode, run) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    let result
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => { database.close(); resolve(result) }
    transaction.onerror = () => { database.close(); reject(transaction.error) }
  })
}

export async function getMediaKit() {
  const saved = await useStore('readonly', store => store.get(KEY))
  return saved ? new File([saved.blob], saved.name, { type: saved.type, lastModified: saved.lastModified }) : null
}

export async function saveMediaKit(file) {
  await useStore('readwrite', store => store.put({ blob: file, name: file.name, type: file.type, lastModified: file.lastModified }, KEY))
}

export async function removeMediaKit() {
  await useStore('readwrite', store => store.delete(KEY))
}
