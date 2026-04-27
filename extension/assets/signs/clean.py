import os
import shutil

def organize_asl_folders(root_path):
    # Supported image extensions
    valid_extensions = ('.jpg', '.jpeg', '.png', '.bmp', '.webp')

    for folder_name in os.listdir(root_path):
        folder_path = os.path.join(root_path, folder_name)

        # Ensure we are looking at a directory
        if os.path.isdir(folder_path):
            # Get a list of all image files in the folder
            images = [f for f in os.listdir(folder_path) if f.lower().endswith(valid_extensions)]
            
            if not images:
                print(f"Skipping '{folder_name}': No images found.")
                continue

            # Identify the target name (lowercase folder name)
            # Example: Folder "A" becomes "a", folder "5" stays "5"
            new_name_base = folder_name.lower()
            
            # Pick the first image found
            first_image = images[0]
            extension = os.path.splitext(first_image)[1]
            new_filename = f"{new_name_base}{extension}"
            
            first_image_path = os.path.join(folder_path, first_image)
            new_image_path = os.path.join(folder_path, new_filename)

            # 1. Rename the first image
            os.rename(first_image_path, new_image_path)
            print(f"Renamed image in '{folder_name}' to '{new_filename}'")

            # 2. Remove all other images/files in that folder
            for remaining_file in os.listdir(folder_path):
                file_to_remove = os.path.join(folder_path, remaining_file)
                if file_to_remove != new_image_path:
                    if os.path.isfile(file_to_remove):
                        os.remove(file_to_remove)
                    elif os.path.isdir(file_to_remove):
                        shutil.rmtree(file_to_remove)

if __name__ == "__main__":
    # Change this to the path where your ASL folders are located
    path_to_data = "./asl_processed/test" 
    organize_asl_folders(path_to_data)