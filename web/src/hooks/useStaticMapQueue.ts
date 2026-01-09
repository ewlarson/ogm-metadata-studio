import { useState, useCallback, useRef } from "react";
import { Resource } from "../aardvark/model";
import { default as pLimit } from "p-limit";
import { StaticMapService } from "../services/StaticMapService";
import { getStaticMap, upsertStaticMap } from "../duckdb/duckdbClient";

// OSM Usage Policy: Be nice.
const limit = pLimit(2);

interface QueueItem {
    id: string;
    resource: Resource;
}

export function useStaticMapQueue() {
    const [mapUrls, setMapUrls] = useState<Record<string, string | null>>({});
    const processedRef = useRef<Set<string>>(new Set());
    const queueRef = useRef<Map<string, QueueItem>>(new Map());

    const processQueue = useCallback(() => {
        const pending = Array.from(queueRef.current.values());
        queueRef.current.clear();

        pending.forEach(item => {
            processedRef.current.add(item.id);

            limit(async () => {
                try {
                    // 1. Check DB Cache
                    const cachedUrl = await getStaticMap(item.id);
                    if (cachedUrl) {
                        setMapUrls(prev => ({ ...prev, [item.id]: cachedUrl }));
                        return;
                    }

                    // 2. Generate
                    const service = new StaticMapService(item.resource);
                    const blob = await service.generate();

                    if (blob) {
                        // 3. Cache
                        await upsertStaticMap(item.id, blob);

                        // 4. Update State
                        const url = URL.createObjectURL(blob);
                        setMapUrls(prev => ({ ...prev, [item.id]: url }));
                    } else {
                        // Failed or no bbox
                        setMapUrls(prev => ({ ...prev, [item.id]: null }));
                    }
                } catch (err) {
                    console.warn(`Error generating static map for ${item.id}`, err);
                    setMapUrls(prev => ({ ...prev, [item.id]: null }));
                }
            });
        });
    }, []);

    const register = useCallback((id: string, resource: Resource) => {
        if (processedRef.current.has(id)) return;
        if (queueRef.current.has(id)) return;

        // If we already have the URL in state, skip
        if (mapUrls[id] !== undefined) return;

        queueRef.current.set(id, { id, resource });
        processQueue();
    }, [mapUrls, processQueue]);

    return { mapUrls, register };
}
