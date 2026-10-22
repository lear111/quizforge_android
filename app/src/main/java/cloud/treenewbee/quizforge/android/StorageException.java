package cloud.treenewbee.quizforge.android;

/** A stable error code suitable for returning to the trusted application page. */
public final class StorageException extends Exception {
    public final String code;

    public StorageException(String code, String message) {
        super(message);
        this.code = code;
    }

    public StorageException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
}
