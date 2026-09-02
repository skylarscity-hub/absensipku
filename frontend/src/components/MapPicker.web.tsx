import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

type Props = { latitude: number | null; longitude: number | null; radius: number; onChange: (lat: number, lng: number) => void };

// Web fallback: react-native-maps doesn't ship a web implementation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function MapPicker({ latitude, longitude, radius, onChange }: Props) {
  return (
    <View testID="map-picker-web-notice" style={styles.notice}>
      <Ionicons name="map-outline" size={22} color="#DC2626" />
      <Text style={styles.text}>
        Live map preview is available on the mobile app. Type the coordinates below or drop the pin from your phone.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { backgroundColor: "#FEF2F2", padding: 16, borderRadius: 14, alignItems: "center", gap: 8, marginBottom: 15 },
  text: { color: "#991B1B", fontSize: 12, textAlign: "center", lineHeight: 18 },
});
