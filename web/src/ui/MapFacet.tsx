import React, { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, useMapEvents, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix for default markers (if we used them, but we might not need markers yet)
// import icon from 'leaflet/dist/images/marker-icon.png';
// import iconShadow from 'leaflet/dist/images/marker-shadow.png';

interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

interface MapFacetProps {
    bbox?: BBox;
    onChange: (bbox: BBox | undefined) => void;
}

const SearchHereButton = ({ onClick }: { onClick: () => void }) => {
    return (
        <div className="absolute top-2 right-2 z-[1000]">
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onClick();
                }}
                className="bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-3 py-1.5 rounded shadow-md border border-gray-300 dark:border-slate-600 text-xs font-semibold hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
            >
                Search Here
            </button>
        </div>
    );
};

const MapController = ({ onSearch }: { onSearch: (bbox: BBox) => void }) => {
    const map = useMapEvents({});
    const [showButton, setShowButton] = useState(true);

    // We can show button only on move, or always. User said "Add a button to 'Search Here'".
    // So distinct action.

    const handleSearch = () => {
        const bounds = map.getBounds();
        const bbox: BBox = {
            minX: bounds.getWest(),
            minY: bounds.getSouth(),
            maxX: bounds.getEast(),
            maxY: bounds.getNorth()
        };
        onSearch(bbox);
    };

    return <SearchHereButton onClick={handleSearch} />;
};

const FitBounds = ({ bbox }: { bbox?: BBox }) => {
    const map = useMap();
    useEffect(() => {
        if (bbox) {
            const bounds = L.latLngBounds(
                L.latLng(bbox.minY, bbox.minX),
                L.latLng(bbox.maxY, bbox.maxX)
            );
            map.fitBounds(bounds, { padding: [10, 10] });
        }
    }, [bbox, map]);
    return null;
}

export const MapFacet: React.FC<MapFacetProps> = ({ bbox, onChange }) => {
    // Default center (US)
    const defaultCenter: [number, number] = [37.8, -96];
    const defaultZoom = 3;

    return (
        <div className="w-full h-48 rounded overflow-hidden border border-gray-200 dark:border-slate-800 relative z-0 mb-4">
            {/* Note: Leaflet needs specific z-index management if in sidebar */}
            <MapContainer
                center={defaultCenter}
                zoom={defaultZoom}
                scrollWheelZoom={true}
                className="w-full h-full"
                attributionControl={false}
            >
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                />

                <MapController onSearch={onChange} />

                {/* Clear Button if bbox is active? */}
                {bbox && (
                    <div className="absolute bottom-1 left-1 z-[1000]">
                        <button
                            onClick={() => onChange(undefined)}
                            className="bg-red-500 text-white px-2 py-1 rounded text-[10px] shadow opacity-80 hover:opacity-100"
                        >
                            Clear Map
                        </button>
                    </div>
                )}

                <FitBounds bbox={bbox} />

            </MapContainer>
        </div>
    );
};
