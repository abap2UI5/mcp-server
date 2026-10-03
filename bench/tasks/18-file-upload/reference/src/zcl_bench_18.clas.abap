CLASS zcl_bench_18 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_material,
        material    TYPE string,
        description TYPE string,
        quantity    TYPE i,
      END OF ty_s_material.
    DATA file      TYPE string.
    DATA file_path TYPE string.
    DATA materials TYPE STANDARD TABLE OF ty_s_material WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS parse
      IMPORTING
        csv TYPE string.
    METHODS base64_decode
      IMPORTING
        val           TYPE string
      RETURNING
        VALUE(result) TYPE xstring.
    METHODS xstring_to_string
      IMPORTING
        val           TYPE xstring
      RETURNING
        VALUE(result) TYPE string.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_18 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `xmlns:z2ui5`  v = `z2ui5.cc`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Material upload` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( materials ) ).

    table->ele( `headerToolbar`
        )->ele( `OverflowToolbar`
            )->tag( n = `FileUploader` ns = `z2ui5`
                )->a( n = `placeholder` v = `Choose a CSV file`
                )->a( n = `path`        v = client->_bind( file_path )
                )->a( n = `value`       v = client->_bind( file )
                )->a( n = `upload`      v = client->_event( `UPLOAD` ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Material`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Description`
        )->end(
        )->ele( `Column`
            )->a( n = `hAlign` v = `End`
            )->tag( `Text`
                )->a( n = `text` v = `Quantity` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{MATERIAL}`
                )->tag( `Text`
                    )->a( n = `text` v = `{DESCRIPTION}`
                )->tag( `Text`
                    )->a( n = `text` v = `{QUANTITY}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `UPLOAD`.
        TRY.
            " the uploader delivers a data URL: data:<mime>;base64,<payload>
            SPLIT file AT `,` INTO DATA(header) DATA(base64).
            IF header NS `base64`.
              client->message_box_display( text = `The file could not be read` type = `error` ).
              RETURN.
            ENDIF.
            parse( xstring_to_string( base64_decode( base64 ) ) ).
            client->message_toast_display( |{ lines( materials ) } materials uploaded| ).
          CATCH cx_root INTO DATA(error).
            client->message_box_display( text = error->get_text( ) type = `error` ).
        ENDTRY.
        CLEAR: file, file_path.
    ENDCASE.

  ENDMETHOD.

  METHOD parse.

    DATA lines TYPE string_table.
    DATA(text) = replace( val = csv sub = cl_abap_char_utilities=>cr_lf with = cl_abap_char_utilities=>newline occ = 0 ).
    SPLIT text AT cl_abap_char_utilities=>newline INTO TABLE lines.

    CLEAR materials.
    LOOP AT lines INTO DATA(line).
      IF condense( line ) IS INITIAL.
        CONTINUE.
      ENDIF.
      SPLIT line AT `;` INTO DATA(material) DATA(description) DATA(quantity).
      APPEND VALUE #( material    = condense( material )
                      description = condense( description )
                      quantity    = condense( quantity ) ) TO materials.
    ENDLOOP.

  ENDMETHOD.

  METHOD base64_decode.

    DATA lv_class TYPE string.

    TRY.
        lv_class = `CL_WEB_HTTP_UTILITY`.
        CALL METHOD (lv_class)=>(`DECODE_X_BASE64`)
          EXPORTING
            encoded = val
          RECEIVING
            decoded = result.

      CATCH cx_root.
        lv_class = `CL_HTTP_UTILITY`.
        CALL METHOD (lv_class)=>(`DECODE_X_BASE64`)
          EXPORTING
            encoded = val
          RECEIVING
            decoded = result.
    ENDTRY.

  ENDMETHOD.

  METHOD xstring_to_string.

    DATA lo_conv  TYPE REF TO object.
    DATA lv_class TYPE string.

    TRY.
        lv_class = `CL_ABAP_CONV_CODEPAGE`.
        CALL METHOD (lv_class)=>create_in
          RECEIVING
            instance = lo_conv.

        CALL METHOD lo_conv->(`IF_ABAP_CONV_IN~CONVERT`)
          EXPORTING
            source = val
          RECEIVING
            result = result.

      CATCH cx_root.
        lv_class = `CL_ABAP_CONV_IN_CE`.
        CALL METHOD (lv_class)=>create
          EXPORTING
            encoding = `UTF-8`
          RECEIVING
            conv     = lo_conv.

        CALL METHOD lo_conv->(`CONVERT`)
          EXPORTING
            input = val
          IMPORTING
            data  = result.
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
