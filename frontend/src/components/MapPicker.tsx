import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Circle } from "react-native-maps";

type Props = { latitude: number | null; longitude: number | null; radius: number; onChange: (lat: number, lng: number) => void };

export default function MapPicker({ latitude, longitude, radius, onChange }: Props) {
  const initialRegion = {
    latitude: latitude ?? -6.2,
    longitude: longitude ?? 106.816666,
    latitudeDelta: 0.01,
    longitudeDelta: 0.01,
  };
  return (
    <View testID="map-picker" style={styles.container}>
      <MapView
        style={styles.map}
        initialRegion={initialRegion}
        onPress={(e) => onChange(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
      >
        {latitude !== null && longitude !== null && (
          <>
            <Marker
              coordinate={{ latitude, longitude }}
              draggable
              onDragEnd={(e) => onChange(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
            />
            <Circle
              center={{ latitude, longitude }}
              radius={radius || 100}
              strokeColor="rgba(220,38,38,0.7)"
              fillColor="rgba(220,38,38,0.15)"
            />
          </>
        )}
      </MapView>
      <View style={styles.hintRow}>
        <Ionicons name="finger-print" size={14} color="#6B7280" />
        <Text style={styles.hint}>Tap the map to move the pin. Red circle shows the geofence radius.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 15 },
  map: { height: 220, borderRadius: 14, overflow: "hidden" },
  hintRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, justifyContent: "center" },
  hint: { color: "#6B7280", fontSize: 12, textAlign: "center" },
});
