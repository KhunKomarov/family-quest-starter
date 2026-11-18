package org.familyquest.starter;

import android.content.res.AssetManager;
import android.webkit.JavascriptInterface;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import javax.net.ssl.HttpsURLConnection;

public final class JournalTransport {
    interface Reply {
        void receive(int status, String body);
    }

    private static final int MAX_RESPONSE_BYTES = 1_500_000;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Reply reply;
    private final URL endpoint;
    private final String token;
    private final boolean car;

    JournalTransport(AssetManager assets, Reply reply) {
        this.reply = reply;
        Properties config = new Properties();
        URL url = null;
        try (InputStream stream = assets.open("sync.properties")) {
            config.load(stream);
            URL candidate = new URL(config.getProperty("endpoint", ""));
            if ("https".equals(candidate.getProtocol()) && !candidate.getHost().isEmpty()
                    && candidate.getUserInfo() == null && candidate.getQuery() == null
                    && candidate.getRef() == null && "/v2/sync".equals(candidate.getPath())) {
                url = candidate;
            }
        } catch (IOException ignored) {
            // The public APK is usable without a private deployment configuration.
        }
        token = config.getProperty("token", "");
        endpoint = token.matches("[0-9a-f]{64}") ? url : null;
        String mode = config.getProperty("mode");
        car = "car".equals(mode) || "touch".equals(mode);
    }

    @JavascriptInterface
    public boolean enabled() {
        return endpoint != null;
    }

    @JavascriptInterface
    public String scope() {
        return endpoint == null ? "" : endpoint.toExternalForm();
    }

    @JavascriptInterface
    public boolean car() {
        return car;
    }

    @JavascriptInterface
    public void exchange(String body) {
        if (endpoint == null || body == null || body.length() > 300_000) {
            reply.receive(0, "");
            return;
        }
        try {
            executor.execute(() -> request(body));
        } catch (RejectedExecutionException ignored) {
            // The activity has been closed.
        }
    }

    void close() {
        executor.shutdownNow();
    }

    private void request(String body) {
        HttpsURLConnection connection = null;
        try {
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            connection = (HttpsURLConnection) endpoint.openConnection();
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(7000);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(data.length);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(data);
            }
            int status = connection.getResponseCode();
            if (status != 200) {
                reply.receive(status, "");
                return;
            }
            try (InputStream stream = connection.getInputStream()) {
                reply.receive(status, readResponse(stream));
            }
        } catch (IOException error) {
            reply.receive(0, "");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readResponse(InputStream stream) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = stream.read(buffer)) != -1) {
            if (body.size() + count > MAX_RESPONSE_BYTES) throw new IOException("Response too large");
            body.write(buffer, 0, count);
        }
        return body.toString("UTF-8");
    }
}
